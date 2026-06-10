--
-- PostgreSQL database dump
--

\restrict 08bYlaBX6H2kTuy2QGAMt3qbZOjbCyXpmKQaUGvjWePQ9LEcVIuIPxpfk033S9A

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

--
-- Data for Name: workers; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.workers (id, worker_name, version, status, last_heartbeat, api_key_hash, jobs_completed, jobs_failed, created_at, updated_at) FROM stdin;
d44a203c-5481-4eaa-864c-4eb3590a6d5f	PC-GANY	WORKER-v1.0.0	online	2026-06-04 06:23:39.046837+00	9eb30c33746ae864d5657dc490777523b6a79bef5f15855555c6d0c78ac32ba5	0	0	2026-06-04 06:22:27.575595+00	2026-06-04 06:22:27.575595+00
cfc9edac-f316-4c67-bb63-01926177900e	EVIDENCE-TEST-1	WORKER-v1.0.0	offline	\N	f8ba98c3f053071cbd5959e66ffd1951d223b96a668dd8e407c319ceddd55e7e	0	0	2026-06-04 07:44:39.17258+00	2026-06-04 07:44:39.17258+00
fb794ddc-7896-473d-a0fc-082f22f093fa	DB-PROOF	WORKER-v1.0.0	offline	\N	d919bd4151ddf82031a75bb8e23fc24fd1dd77e2aabfe96fa47f99d669241f04	0	0	2026-06-04 07:44:55.233936+00	2026-06-04 07:44:55.233936+00
277a92d3-b2df-47bd-af5d-b1cf230ccaa9	DB-PROOF-VERCEL	WORKER-v1.0.0	offline	\N	3ae818fea6cc3e4cba0f554c7e358da55dfdf87fb10279f4f3896ca57c89416e	0	0	2026-06-04 07:45:02.603939+00	2026-06-04 07:45:02.603939+00
2cd76b04-6087-44f2-b98b-942489f24cfa	HERMES-VPS-DB	WORKER-v1.0.0	offline	\N	6bc8d4c3c6ed30ae684b782cc3cea4bcfab27673aa13fc798a19c0cf0b09488b	0	0	2026-06-04 07:45:19.103906+00	2026-06-04 07:45:19.103906+00
00e5e0f7-9b5a-4c7a-a9da-8aec43e286e7	HERMES-NEON-DB	WORKER-v1.0.0	offline	\N	946c1adbe3acfe0377f0b1e0da0c6a06f9b77d844d5b31257906d48b17020b95	0	0	2026-06-04 07:45:19.402765+00	2026-06-04 07:45:19.402765+00
bf56f92c-28f5-456f-972c-2a9032a15bac	AUDIT-LOCAL-VERIFICATION-$(date +%s)	WORKER-v1.0.0	offline	\N	0445f1730f36b4792758f676925a1f0949247af767abc5e61c87f0eed4a03fca	0	0	2026-06-04 07:51:37.232999+00	2026-06-04 07:51:37.232999+00
\.


--
-- Data for Name: jobs_queue; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.jobs_queue (id, youtube_id, youtube_url, worker_id, claimed_at, status, result, error_message, transcript_source, confidence, full_transcript, duration_ms, created_at, updated_at, completed_at, retry_count, max_retries) FROM stdin;
3fbb0a27-7880-4a64-bb2a-ec4e4b1a4aeb	J---aiyznGQ	https://www.youtube.com/watch?v=J---aiyznGQ	\N	\N	pending	\N	\N	\N	\N	\N	\N	2026-06-04 07:19:42.308471+00	2026-06-04 07:19:42.308471+00	\N	0	3
\.


--
-- PostgreSQL database dump complete
--

\unrestrict 08bYlaBX6H2kTuy2QGAMt3qbZOjbCyXpmKQaUGvjWePQ9LEcVIuIPxpfk033S9A

