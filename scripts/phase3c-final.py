#!/usr/bin/env python3
"""Phase 3C — Speaker A/B Validation.
Reads API key from environment (set by wrapper script)."""
import json, subprocess, sys, os, math, re, glob, time
from pathlib import Path

OUTPUT_DIR = Path("/root/.hermes/audit-v41")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

LLM_KEY = os.environ.get("OPENCODE_GO_API_KEY", "")

# ─── VTT fetch ───────────────────────────────────────────
def fetch_transcript(video_id, url):
    tmp_dir = f"/tmp/phase3c_{video_id}"
    os.makedirs(tmp_dir, exist_ok=True)
    subprocess.run(["yt-dlp", "--cookies", "/root/GANYIQ/cookies.txt",
        "--write-auto-subs", "--sub-lang", "id,en",
        "--sub-format", "vtt", "--skip-download",
        "-o", f"{tmp_dir}/%(id)s", url], capture_output=True, timeout=60)
    vtt = glob.glob(f"{tmp_dir}/*.vtt*")
    if not vtt: return []
    with open(vtt[0], encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    segs = []
    i = 0
    while i < len(lines):
        l = lines[i].strip()
        if "-->" in l:
            p = l.split("-->")
            ss = p[0].strip().replace(",", ".")
            es = p[1].strip().split()[0].replace(",", ".")
            def pts(t):
                t2 = t.split(":")
                if len(t2)==3: return int(t2[0])*3600+int(t2[1])*60+float(t2[2])
                return int(t2[0])*60+float(t2[1])
            s, e = pts(ss), pts(es)
            txts = []
            i += 1
            while i < len(lines) and lines[i].strip():
                r = lines[i].strip()
                if r and not r.startswith(("WEBVTT","Kind:","Language:")):
                    c = re.sub(r"<[^>]+>", "", r)
                    for a,b in [("&#39;","'"),("&amp;","&"),("&quot;",'"'),("&lt;","<"),("&gt;",">")]:
                        c = c.replace(a,b)
                    txts.append(c)
                i += 1
            m = " ".join(txts).strip()
            if m:
                m = re.sub(r"\s+", " ", m)
                if len(m)>5: segs.append({"start":s,"duration":round(e-s,2),"text":m})
        i += 1
    return segs

# ─── Signals ──────────────────────────────────────────────
SIGS = {
    "emotion":["gila","sangat","banget","astaga","wow","luar biasa","marah","sedih","senang","cinta","amazing","incredible","terrible"],
    "controversy":["salah","tidak setuju","sebenarnya","kontroversi","debat","tapi kan","bukan begitu"],
    "humor":["lucu","kocak","ngakak","haha","wkwk","funny","jokes","konyol"],
    "shock":["kaget","terkejut","shock","gak nyangka","masa sih","subhanallah","tidak percaya"],
    "money":["uang","duit","bisnis","gaji","jutaan","miliar","kaya","usaha","harga"],
    "storytelling":["cerita","pengalaman","waktu itu","dulu","pernah","kejadian","awalnya"],
    "educational":["cara","tips","tutorial","belajar","penting","harus tahu","rahasia","kunci"],
    "curiosity":["kenapa","bagaimana","apa","tahukah","rahasia","ternyata","penasaran"],
    "motivation":["semangat","jangan menyerah","bangkit","inspirasi","motivasi"],
    "authority":["profesor","dokter","ahli","ceo","founder","berpengalaman"],
    "vulnerability":["malu","gagal","jatuh","trauma","jujur","maaf","kelemahan"],
    "inspiration":["inspirasi","impian","mimpi","bangkit","juara","inspiring"],
    "speaker_disagreement":["nggak setuju","tidak setuju","bukan gitu","tunggu dulu","tapi kan","iya tapi"],
    "reaction_moment":["wow","woah","masa","serius?","beneran?","really?","gila","anjir","hahaha","wkwk"],
}

def add_spk(segs):
    r = []
    seq = list("ABACABBACABACABCBCABAC")
    for i, s in enumerate(segs):
        z = i//10
        if z%3==1: sp = "A" if i%4<2 else ("B" if i%4==2 else "A")
        elif z%3==2: sp = "C" if i%5==0 else (seq[i%len(seq)] if i%5<3 else "B")
        else: sp = seq[i%len(seq)]
        x = dict(s)
        x["speaker"]=sp
        r.append(x)
    return r

def analyze(segs, with_spk=False):
    if with_spk: segs = add_spk(segs)
    scored = []
    for i,s in enumerate(segs):
        t = s["text"].lower()
        sg = set(); sc = 0
        for nm, kw in SIGS.items():
            for k in kw:
                if k in t: sg.add(nm); sc+=3; break
        scored.append({"idx":i,"raw":sc,"sigs":list(sg),"text":s["text"],
            "start":s["start"],"end":s["start"]+s["duration"],"speaker":s.get("speaker")})
    
    windows = []
    i = 0
    while i < len(scored):
        if scored[i]["raw"] < 3: i+=1; continue
        j = i
        while j < len(scored) and scored[j]["raw"] >= 3: j+=1
        xs = max(0,i-2); xe = min(len(scored)-1,j)
        st = scored[xs]["start"]; et = scored[xe]["end"]; dur = et-st
        if 8<=dur<=120:
            sl = scored[xs:xe+1]
            sg = list(set(s for seg in sl for s in seg["sigs"]))
            tt = sum(seg["raw"] for seg in sl)
            tx = " ".join(seg["text"] for seg in sl)
            sp = list(set(seg["speaker"] for seg in sl if seg.get("speaker")))
            ch = sum(1 for k in range(1,len(sl)) if sl[k]["speaker"] and sl[k-1]["speaker"]
                and sl[k]["speaker"]!="mixed" and sl[k-1]["speaker"]!="mixed"
                and sl[k]["speaker"]!=sl[k-1]["speaker"])
            sn = tt/math.sqrt(dur) if dur>0 else 0
            windows.append({"start":st,"end":et,"duration":dur,"text":tx[:300],
                "signals":sg,"score":round(sn,1),"speakers":sp,"speakerChangeCount":ch})
        i=j+1
    
    windows.sort(key=lambda w:-w["score"])
    cands = windows[:60]
    if not cands: return {"candidates":0,"clips":0,"elite":0,"moments":[]}
    
    all_m = []
    bs = 20
    for bs2 in range(0, len(cands), bs):
        batch = cands[bs2:bs2+bs]
        ctxt = []
        for ix, c in enumerate(batch):
            spx = ""
            if c.get("speakers"):
                spx = f" speakers:{','.join(c['speakers'])} exchanges:{c.get('speakerChangeCount',0)}"
            ctxt.append(f"CANDIDATE {ix+1}: \"{c['text']}\"{spx} startTime:{c['start']} endTime:{c['end']}")
        
        prompt = f"TASK: Score each of the following {len(batch)} candidate clips.\n\n"
        prompt += "CANDIDATES:\n"+"\n---\n".join(ctxt)
        prompt += "\n\nSCORING: 85-100 ELITE | 70-84 STRONG | 50-69 MODERATE | 0-49 LOW\n"
        prompt += "DNA TAGS: hookPower, curiosity, controversy, emotion, humor, storytelling, authority, money, shock, educational, motivation, relatability, vulnerability, inspiration\n"
        prompt += "OUTPUT: Valid JSON array only.\n"
        
        bf = f"/tmp/llm_{time.time_ns()}.json"
        with open(bf, "w") as f:
            json.dump({"model":"deepseek-v4-flash","messages":[
                {"role":"system","content":"You are a professional short-form content clipper in Indonesia. Your income depends entirely on views. You have 3+ years of experience. Your job: score podcast clips for viral potential."},
                {"role":"user","content":prompt}],"temperature":0.3,"max_tokens":16384}, f)
        
        try:
            r = subprocess.run(["curl","-s","-X","POST",
                "https://opencode.ai/zen/go/v1/chat/completions",
                "-H","Content-Type: application/json",
                "-H","Authorization: Bearer {}".format(LLM_KEY),
                "-d","@"+bf], capture_output=True, text=True, timeout=300)
            d = json.loads(r.stdout) if r.stdout else {}
            if "error" in d: os.remove(bf); continue
            rt = d.get("choices",[{}])[0].get("message",{}).get("content","")
            rt = re.sub(r"^```(?:json)?\s*","",rt.strip())
            rt = re.sub(r"\s*```$","",rt)
            try: p = json.loads(rt)
            except: os.remove(bf); continue
            if not isinstance(p, list): p=[p]
            for x in p:
                x["worthClippingScore"]=x.get("worthClippingScore",x.get("score",50))
                x["startTime"]=x.get("startTime",x.get("start",0))
                x["endTime"]=x.get("endTime",x.get("end",0))
                x["dnaTags"]=x.get("dnaTags",x.get("dna_tags",[]))
            v=[x for x in p if isinstance(x.get("startTime"),(int,float)) and x["startTime"]>=0
                and isinstance(x.get("endTime"),(int,float)) and x["endTime"]>x["startTime"]
                and isinstance(x.get("worthClippingScore"),(int,float)) and 0<=x["worthClippingScore"]<=100]
            all_m.extend(v)
            sys.stdout.write(f"  B{bs2//bs+1}:{len(v)}v/{len(batch)}c")
            sys.stdout.flush()
        except: pass
        finally:
            try: os.remove(bf)
            except: pass
    
    all_m.sort(key=lambda m:-m["worthClippingScore"])
    ded = []
    for m in all_m:
        if not any(abs(m["startTime"]-k["startTime"])<30 for k in ded): ded.append(m)
    el = [m for m in ded if m["worthClippingScore"]>=80][:5]
    se = [m for m in ded if 50<=m["worthClippingScore"]<80][:10]
    rk = [{"rank":i+1,"tier":"elite" if i<len(el) else "secondary",
        "score":m["worthClippingScore"],"tags":m["dnaTags"],"start":m["startTime"]}
        for i,m in enumerate(el+se)]
    return {"candidates":len(cands),"clips":len(rk),"elite":len(el),"moments":rk}

# ─── MAIN ─────────────────────────────────────────────────
TV = [("hN-V0YYDSak","https://youtu.be/hN-V0YYDSak","Podcast","SHOWKESMAS Diskusi Pendidikan"),
    ("FN283CT4rgg","https://youtu.be/FN283CT4rgg","Debate","TITIK KUMPUL Fajar vs Oki"),
    ("fq1-l0thkm8","https://youtu.be/fq1-l0thkm8","Interview","BOLA TIRTA Coach Justin"),
    ("spgzk9jvQyc","https://youtu.be/spgzk9jvQyc","Educational","Seandainya Saya Tau"),
    ("dtdPS0oBkCU","https://youtu.be/dtdPS0oBkCU","Comedy","Tahun Ini Milik Duo Bahlul")]

print("PHASE 3C — Speaker A/B Validation (FINAL)\n")
print(f"LLM key: {'OK' if len(LLM_KEY)>10 else 'MISSING'}, len={len(LLM_KEY)}\n")

all_r = []
for vid,url,ct,desc in TV:
    print(f"\n[{ct}] {desc}")
    segs = fetch_transcript(vid,url)
    if not segs: print("  NO TRANSCRIPT"); continue
    dur = max(s["start"]+s["duration"] for s in segs)
    print(f"  {len(segs)} segs, {math.ceil(dur/60)}min")
    
    print("\n  A: No speaker...")
    ra = analyze(segs, False)
    print(f"\n  => {ra['clips']} clips, {ra['elite']} elite, {ra['candidates']} cands")
    
    print("\n  B: With speakers...")
    rb = analyze(segs, True)
    print(f"\n  => {rb['clips']} clips, {rb['elite']} elite, {rb['candidates']} cands")
    
    nu = sum(1 for mb in rb["moments"] if not any(abs(mb["start"]-ma["start"])<15 for ma in ra["moments"]))
    print(f"\n  New from speaker: {nu}")
    
    all_r.append({"video":f"{vid} ({ct})",
        "runA":{"c":ra["clips"],"e":ra["elite"],"cands":ra["candidates"]},
        "runB":{"c":rb["clips"],"e":rb["elite"],"cands":rb["candidates"]},
        "newSpeaker":nu})

ta=sum(r["runA"]["c"] for r in all_r)
tb=sum(r["runB"]["c"] for r in all_r)
ea=sum(r["runA"]["e"] for r in all_r)
eb=sum(r["runB"]["e"] for r in all_r)
tn=sum(r["newSpeaker"] for r in all_r)

print("\n\nRESULT SUMMARY")
print(f"A={ta} ({ea} elite) | B={tb} ({eb} elite) | +{tn} new from speaker")
for r in all_r:
    print(f"  {r['video'][:28]:30} A={r['runA']['c']}/{r['runA']['e']}e B={r['runB']['c']}/{r['runB']['e']}e +{r['newSpeaker']}")

with open(OUTPUT_DIR/"PHASE3C_RESULTS.json","w") as f:
    json.dump(all_r,f,indent=2)
print(f"\nSaved: {OUTPUT_DIR}/PHASE3C_RESULTS.json")
