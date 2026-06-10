--
-- PostgreSQL database dump
--

\restrict eK0c6gCRIyCwOp8FikE73ONcnjsfMa2PTAGnwhb2PaMI9jFkOr3dNockcTPZYqu

-- Dumped from database version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_table_access_method = heap;

--
-- Name: _migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public._migrations (
    id integer NOT NULL,
    filename character varying(255) NOT NULL,
    executed_at timestamp with time zone DEFAULT now()
);


--
-- Name: _migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public._migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: _migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public._migrations_id_seq OWNED BY public._migrations.id;


--
-- Name: analyses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analyses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    video_id uuid NOT NULL,
    ip_address character varying(45),
    total_moments_found integer,
    processing_time_ms integer,
    llm_model character varying(50) DEFAULT 'gemini-2.0-flash'::character varying,
    prompt_version character varying(20) DEFAULT 'mvp-v1'::character varying,
    raw_llm_response jsonb,
    status character varying(20) DEFAULT 'completed'::character varying,
    error_message text,
    created_at timestamp with time zone DEFAULT now(),
    transcript_source character varying(20) DEFAULT 'youtube'::character varying,
    CONSTRAINT analyses_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'completed'::character varying, 'failed'::character varying])::text[]))),
    CONSTRAINT analyses_transcript_source_check CHECK (((transcript_source)::text = ANY ((ARRAY['youtube'::character varying, 'deepgram'::character varying])::text[])))
);


--
-- Name: COLUMN analyses.transcript_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.analyses.transcript_source IS 'Source of transcript: ''youtube'' (native InnerTube API) or ''deepgram'' (fallback via yt-dlp + Deepgram STT)';


--
-- Name: clips_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clips_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    video_id uuid NOT NULL,
    start_time numeric(10,2) NOT NULL,
    end_time numeric(10,2) NOT NULL,
    filename character varying(255) NOT NULL,
    file_size_bytes integer,
    duration_seconds numeric(5,1),
    has_subtitles boolean DEFAULT false NOT NULL,
    job_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    render_mode character varying(10) DEFAULT 'landscape'::character varying NOT NULL,
    CONSTRAINT clips_cache_render_mode_check CHECK (((render_mode)::text = ANY ((ARRAY['landscape'::character varying, 'vertical'::character varying])::text[])))
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    analysis_id uuid,
    event_type character varying(50) NOT NULL,
    metadata jsonb,
    ip_address character varying(45),
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: jobs_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    youtube_id character varying(20) NOT NULL,
    youtube_url text NOT NULL,
    worker_id uuid,
    claimed_at timestamp with time zone,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    result jsonb,
    error_message text,
    transcript_source character varying(20),
    confidence numeric(4,3),
    full_transcript text,
    duration_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    retry_count integer DEFAULT 0 NOT NULL,
    max_retries integer DEFAULT 3 NOT NULL,
    job_type character varying(20) DEFAULT 'transcript'::character varying NOT NULL,
    clip_params jsonb,
    CONSTRAINT jobs_queue_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'claimed'::character varying, 'completed'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: moments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.moments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    analysis_id uuid NOT NULL,
    start_time numeric(10,2) NOT NULL,
    end_time numeric(10,2) NOT NULL,
    worth_clipping_score numeric(5,2) NOT NULL,
    confidence character varying(10) NOT NULL,
    dna_tags jsonb NOT NULL,
    reasoning text,
    transcript_excerpt text,
    rank_position integer,
    tier character varying(10),
    CONSTRAINT moments_confidence_check CHECK (((confidence)::text = ANY ((ARRAY['high'::character varying, 'medium'::character varying, 'low'::character varying])::text[]))),
    CONSTRAINT moments_tier_check CHECK (((tier)::text = ANY ((ARRAY['elite'::character varying, 'secondary'::character varying])::text[])))
);


--
-- Name: videos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.videos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    youtube_id character varying(20) NOT NULL,
    title text,
    channel_name character varying(255),
    duration_seconds integer,
    transcript jsonb,
    fetched_at timestamp with time zone DEFAULT now()
);


--
-- Name: workers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    worker_name character varying(100) NOT NULL,
    version character varying(20) DEFAULT 'WORKER-v1.0.0'::character varying NOT NULL,
    status character varying(20) DEFAULT 'offline'::character varying NOT NULL,
    last_heartbeat timestamp with time zone,
    api_key_hash character varying(64) NOT NULL,
    jobs_completed integer DEFAULT 0 NOT NULL,
    jobs_failed integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workers_status_check CHECK (((status)::text = ANY ((ARRAY['online'::character varying, 'offline'::character varying])::text[])))
);


--
-- Name: _migrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._migrations ALTER COLUMN id SET DEFAULT nextval('public._migrations_id_seq'::regclass);


--
-- Name: _migrations _migrations_filename_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._migrations
    ADD CONSTRAINT _migrations_filename_key UNIQUE (filename);


--
-- Name: _migrations _migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._migrations
    ADD CONSTRAINT _migrations_pkey PRIMARY KEY (id);


--
-- Name: analyses analyses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analyses
    ADD CONSTRAINT analyses_pkey PRIMARY KEY (id);


--
-- Name: clips_cache clips_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clips_cache
    ADD CONSTRAINT clips_cache_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: jobs_queue jobs_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs_queue
    ADD CONSTRAINT jobs_queue_pkey PRIMARY KEY (id);


--
-- Name: moments moments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moments
    ADD CONSTRAINT moments_pkey PRIMARY KEY (id);


--
-- Name: videos videos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.videos
    ADD CONSTRAINT videos_pkey PRIMARY KEY (id);


--
-- Name: videos videos_youtube_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.videos
    ADD CONSTRAINT videos_youtube_id_key UNIQUE (youtube_id);


--
-- Name: workers workers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workers
    ADD CONSTRAINT workers_pkey PRIMARY KEY (id);


--
-- Name: workers workers_worker_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workers
    ADD CONSTRAINT workers_worker_name_key UNIQUE (worker_name);


--
-- Name: idx_analyses_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_analyses_created_at ON public.analyses USING btree (created_at DESC);


--
-- Name: idx_analyses_video_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_analyses_video_id ON public.analyses USING btree (video_id);


--
-- Name: idx_clips_video_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clips_video_id ON public.clips_cache USING btree (video_id);


--
-- Name: idx_clips_video_start_end_render; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_clips_video_start_end_render ON public.clips_cache USING btree (video_id, start_time, end_time, render_mode);


--
-- Name: idx_events_analysis_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_analysis_id ON public.events USING btree (analysis_id);


--
-- Name: idx_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_type ON public.events USING btree (event_type);


--
-- Name: idx_jobs_queue_poll; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_queue_poll ON public.jobs_queue USING btree (created_at, status) WHERE (((status)::text = 'pending'::text) AND (retry_count < max_retries));


--
-- Name: idx_jobs_queue_stale; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_queue_stale ON public.jobs_queue USING btree (claimed_at, status) WHERE ((status)::text = 'claimed'::text);


--
-- Name: idx_jobs_queue_video; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_queue_video ON public.jobs_queue USING btree (youtube_id, status);


--
-- Name: idx_jobs_queue_worker_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_queue_worker_active ON public.jobs_queue USING btree (worker_id, status) WHERE ((status)::text = 'claimed'::text);


--
-- Name: idx_moments_analysis_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_moments_analysis_id ON public.moments USING btree (analysis_id);


--
-- Name: idx_moments_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_moments_score ON public.moments USING btree (worth_clipping_score DESC);


--
-- Name: idx_videos_youtube_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_videos_youtube_id ON public.videos USING btree (youtube_id);


--
-- Name: idx_workers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workers_status ON public.workers USING btree (status, last_heartbeat);


--
-- Name: analyses analyses_video_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analyses
    ADD CONSTRAINT analyses_video_id_fkey FOREIGN KEY (video_id) REFERENCES public.videos(id);


--
-- Name: clips_cache clips_cache_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clips_cache
    ADD CONSTRAINT clips_cache_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs_queue(id);


--
-- Name: clips_cache clips_cache_video_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clips_cache
    ADD CONSTRAINT clips_cache_video_id_fkey FOREIGN KEY (video_id) REFERENCES public.videos(id) ON DELETE CASCADE;


--
-- Name: events events_analysis_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.analyses(id);


--
-- Name: jobs_queue jobs_queue_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs_queue
    ADD CONSTRAINT jobs_queue_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES public.workers(id);


--
-- Name: moments moments_analysis_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moments
    ADD CONSTRAINT moments_analysis_id_fkey FOREIGN KEY (analysis_id) REFERENCES public.analyses(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict eK0c6gCRIyCwOp8FikE73ONcnjsfMa2PTAGnwhb2PaMI9jFkOr3dNockcTPZYqu