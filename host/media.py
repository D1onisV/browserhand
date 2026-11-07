#!/usr/bin/env python3
"""BrowserHand media tool: watch, listen to, download and edit video and audio.

    media <cmd> <src> [options]        src = URL (YouTube and ~1000 other sites) or local file

  info  SRC                              title, duration, fps, size, chapters (no download)
  look  SRC [--from T --to T]            frames with burned-in timestamps
        [--fps F | --every S | --scenes] [--max N] [--grid | --nogrid] [--width W]
        default: overview (~24 frames evenly over the range, packed 3x3 into sheets)
        dense:   --from 0:42 --to 0:45 --fps 15   (every 2nd frame of 30fps video)
  frame SRC T [--width W]                one full-size frame at time T (for details)
  hear  SRC [--from T --to T] [--lang uk] [--model M] [--subs]
                                         speech → text with timestamps (+ .srt saved)
  sound SRC [--from T --to T]            music/sound: tempo, beats, loudness curve, silences, hits
  get   SRC [--audio] [--height H] [--from T --to T]   download, prints the file path
  cut   SRC --from T --to T [-o OUT] [--copy]          trim
  audio SRC [-o OUT.mp3]                 extract audio
  concat FILE FILE ... -o OUT            join clips
  vertical SRC [-o OUT]                  crop/scale to 1080x1920 (9:16)
  subs  SRC [-o OUT] [--lang uk]         burn subtitles from speech recognition
  gif   SRC --from T --to T [-o OUT] [--width W] [--fps F]
  speed SRC FACTOR [-o OUT]              0.5 = slower, 2 = faster (audio pitch kept)

Times: 83 | 1:23 | 01:01:23.5.  Results go to host/data/media/<id>/.
"""
import argparse, hashlib, json, math, os, re, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
MEDIA = HERE / 'data' / 'media'
MEDIA.mkdir(parents=True, exist_ok=True)
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# ---------------- helpers ----------------
def die(msg):
    print('ERROR: ' + msg, file=sys.stderr)
    sys.exit(1)

def run(cmd, capture=True, check=True):
    p = subprocess.run(cmd, capture_output=capture, text=True, encoding='utf-8', errors='replace')
    if check and p.returncode != 0:
        tail = (p.stderr or '').strip().splitlines()[-6:]
        die(f"{Path(cmd[0]).name} failed:\n" + '\n'.join(tail))
    return p

def need(tool):
    if not shutil.which(tool):
        die(f'{tool} is not installed (needed for this command)')

def secs(t):
    if t is None or t == '':
        return None
    if isinstance(t, (int, float)):
        return float(t)
    parts = [float(x) for x in str(t).replace(',', '.').split(':')]
    s = 0.0
    for x in parts:
        s = s * 60 + x
    return s

def hms(s, ms=True):
    s = max(0.0, float(s))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    out = f'{int(h)}:{int(m):02d}:' if h >= 1 else f'{int(m)}:'
    return out + (f'{sec:05.2f}' if ms else f'{int(sec):02d}')

def is_url(s):
    return bool(re.match(r'^https?://', s or ''))

def slug_for(src):
    if is_url(src):
        m = re.search(r'(?:v=|youtu\.be/|shorts/|/video/|/reel/)([\w-]{6,})', src)
        key = m.group(1) if m else hashlib.sha1(src.encode()).hexdigest()[:10]
        return 'url-' + key
    p = Path(src).resolve()
    h = hashlib.sha1(f'{p}|{p.stat().st_size}|{int(p.stat().st_mtime)}'.encode()).hexdigest()[:8]
    return re.sub(r'[^\w.-]+', '_', p.stem)[:40] + '-' + h

def workdir(src):
    d = MEDIA / slug_for(src)
    d.mkdir(parents=True, exist_ok=True)
    return d

def range_tag(a, b):
    return '' if a is None and b is None else f"_{int((a or 0)*1000)}-{int(b*1000) if b is not None else 'end'}"

# ---------------- download / local file ----------------
def ytdlp_info(url):
    need('yt-dlp')
    p = run(['yt-dlp', '-J', '--no-playlist', '--no-warnings', url])
    return json.loads(p.stdout)

def download(url, audio=False, height=720, a=None, b=None):
    """Download (cached) and return the local path."""
    need('yt-dlp'); need('ffmpeg')
    d = workdir(url)
    tag = ('audio' if audio else f'v{height}') + range_tag(a, b)
    hit = [f for f in d.glob(f'src_{tag}.*') if not f.name.endswith(('.part', '.ytdl'))]
    if hit:
        return hit[0]
    fmt = 'bestaudio/best' if audio else f'bv*[height<={height}]+ba/b[height<={height}]/bv*+ba/b'
    cmd = ['yt-dlp', '--no-playlist', '--no-warnings', '-q', '-f', fmt, '-o', str(d / f'src_{tag}.%(ext)s')]
    if not audio:
        cmd += ['--merge-output-format', 'mp4']
    if a is not None or b is not None:
        cmd += ['--download-sections', f"*{a or 0}-{b if b is not None else 'inf'}", '--force-keyframes-at-cuts']
    cmd.append(url)
    run(cmd)
    hit = [f for f in d.glob(f'src_{tag}.*') if not f.name.endswith(('.part', '.ytdl'))]
    if not hit:
        die('download finished but no file found')
    return hit[0]

def local(src, audio=False, a=None, b=None):
    """Return (path, offset): offset = start time of the file inside the original (for section downloads)."""
    if not is_url(src):
        p = Path(src)
        if not p.exists():
            die(f'file not found: {src}')
        return p, 0.0
    # For long ranges in long videos, download only the section.
    if a is not None or b is not None:
        return download(src, audio=audio, a=a, b=b), (a or 0.0)
    return download(src, audio=audio), 0.0

def probe(path):
    need('ffprobe')
    p = run(['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', str(path)])
    j = json.loads(p.stdout)
    v = next((s for s in j['streams'] if s['codec_type'] == 'video' and s.get('disposition', {}).get('attached_pic') != 1), None)
    au = next((s for s in j['streams'] if s['codec_type'] == 'audio'), None)
    fps = None
    if v and v.get('avg_frame_rate', '0/0') != '0/0':
        n, dd = v['avg_frame_rate'].split('/')
        fps = round(float(n) / float(dd), 3) if float(dd) else None
    return {
        'duration': float(j['format'].get('duration', 0) or 0),
        'width': v and v.get('width'), 'height': v and v.get('height'), 'fps': fps,
        'video': bool(v), 'audio': bool(au),
        'vcodec': v and v.get('codec_name'), 'acodec': au and au.get('codec_name'),
    }

FONT = next((f for f in ['C:/Windows/Fonts/arial.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf',
                         '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/Library/Fonts/Arial.ttf'] if os.path.exists(f)), None)

def stamp_filter(size=22):
    """drawtext with the original timestamp (works together with -copyts)."""
    if not FONT:
        return None
    f = FONT.replace(':', '\\:')
    return (f"drawtext=fontfile='{f}':text='%{{pts\\:hms}}':x=8:y=8:fontsize={size}:"
            "fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=5")

# ---------------- info ----------------
def cmd_info(o):
    if is_url(o.src):
        j = ytdlp_info(o.src)
        out = {
            'title': j.get('title'), 'channel': j.get('uploader') or j.get('channel'),
            'duration': hms(j.get('duration') or 0, ms=False), 'seconds': j.get('duration'),
            'resolution': f"{j.get('width')}x{j.get('height')}" if j.get('width') else None, 'fps': j.get('fps'),
            'views': j.get('view_count'), 'uploaded': j.get('upload_date'),
            'subtitles': sorted((j.get('subtitles') or {}).keys())[:15],
            'auto_captions': 'yes' if j.get('automatic_captions') else 'no',
            'chapters': [f"{hms(c['start_time'], ms=False)} {c.get('title')}" for c in (j.get('chapters') or [])][:40],
            'description': (j.get('description') or '')[:600],
        }
    else:
        p = probe(o.src)
        out = {'file': str(Path(o.src).resolve()), 'duration': hms(p['duration'], ms=False), 'seconds': round(p['duration'], 2),
               'resolution': f"{p['width']}x{p['height']}" if p['video'] else None, 'fps': p['fps'],
               'video': p['vcodec'], 'audio': p['acodec']}
    print(json.dumps({k: v for k, v in out.items() if v not in (None, [], '')}, ensure_ascii=False, indent=1))

# ---------------- look (frames) ----------------
def cmd_look(o):
    need('ffmpeg')
    a, b = secs(o.from_), secs(o.to)
    path, off = local(o.src, a=a, b=b) if is_url(o.src) and (a is not None or b is not None) and o.section else local(o.src)
    info = probe(path)
    if not info['video']:
        die('this source has no video track (use hear / sound)')
    dur = info['duration']
    # times inside the file
    fa = max(0.0, (a or 0.0) - off)
    fb = min(dur, (b - off) if b is not None else dur)
    span = max(0.04, fb - fa)
    src_fps = info['fps'] or 30

    if o.scenes:
        mode = 'scenes'
    elif o.fps:
        mode, rate = 'fps', float(o.fps)
    elif o.every:
        mode, rate = 'fps', 1.0 / float(o.every)
    else:
        mode, rate = 'fps', max(0.05, min(src_fps, o.max / span))  # overview: spread `max` frames
    if mode == 'fps':
        rate = min(rate, src_fps)
        want = math.ceil(span * rate)
        if want > o.max and not o.force:
            rate = o.max / span
            print(f'note: {want} frames requested, limited to --max {o.max} (rate {rate:.2f}/s). Use --force or a shorter range.')

    tag = hashlib.sha1(f'{mode}|{fa}|{fb}|{o.fps}|{o.every}|{o.max}|{o.width}|{o.grid}|{o.cols}'.encode()).hexdigest()[:8]
    out = path.parent / f'look_{tag}'
    if out.exists():
        shutil.rmtree(out)
    out.mkdir()

    chain = []
    if mode == 'scenes':
        chain.append(f"select='eq(n\\,0)+gt(scene\\,{o.threshold})'")  # first frame + every cut
    else:
        chain.append(f'fps={rate}')
    st = stamp_filter(max(16, o.width // 32))
    if st:
        chain.append(st)
    chain.append(f'scale={o.width}:-2')
    chain.append('showinfo')

    grid = o.grid
    cmd = ['ffmpeg', '-v', 'info', '-hide_banner', '-y', '-copyts', '-ss', f'{fa:.3f}', '-to', f'{fb:.3f}', '-i', str(path),
           '-an', '-vf', ','.join(chain), '-fps_mode', 'vfr', '-q:v', '3', str(out / 'f_%04d.jpg')]
    p = run(cmd)
    times = [float(m) for m in re.findall(r'pts_time:([\d.]+)', p.stderr)]
    frames = sorted(out.glob('f_*.jpg'))
    if mode == 'scenes' and len(frames) > o.max:  # thin out evenly
        keep = set(round(i * (len(frames) - 1) / (o.max - 1)) for i in range(o.max))
        for i, f in enumerate(frames):
            if i not in keep:
                f.unlink()
        times = [t for i, t in enumerate(times) if i in keep]
        frames = sorted(out.glob('f_*.jpg'))
    if not frames:
        die('no frames extracted (range outside the video, or no scene changes — try without --scenes)')
    times = [t + off for t in times][:len(frames)]

    if grid is None:
        grid = len(frames) > 12
    print(f"{('scene changes' if mode == 'scenes' else f'{rate:.3g} frames/s')} · {hms(fa + off)}–{hms(fb + off)} · {len(frames)} frames · source {info['width']}x{info['height']} {src_fps}fps")
    if grid:
        cols = o.cols
        per = cols * cols
        sheets = []
        for i in range(0, len(frames), per):
            chunk = frames[i:i + per]
            sheet = out / f'sheet_{i // per + 1:02d}.jpg'
            lst = out / f'list_{i // per + 1:02d}.txt'
            lst.write_text(''.join(f"file '{f.as_posix()}'\n" for f in chunk), encoding='utf-8')
            rows = math.ceil(len(chunk) / cols)
            run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(lst),
                 '-vf', f'tile={cols}x{rows}:padding=4:color=black', '-frames:v', '1', '-q:v', '3', str(sheet)])
            sheets.append((sheet, times[i] if i < len(times) else None, times[i + len(chunk) - 1] if i + len(chunk) - 1 < len(times) else None))
        print(f'{len(sheets)} sheet(s) of {cols}x{cols}, read left→right, top→bottom; each frame shows its timestamp:')
        for s, t0, t1 in sheets:
            print(f"  {hms(t0) if t0 is not None else '?'}–{hms(t1) if t1 is not None else '?'}  {s}")
    else:
        for f, t in zip(frames, times + [None] * len(frames)):
            print(f"  {hms(t) if t is not None else '?'}  {f}")

def cmd_frame(o):
    need('ffmpeg')
    t = secs(o.time)
    path, off = local(o.src)
    out = path.parent / f'frame_{int(t * 1000)}_{o.width}.jpg'
    chain = [f'scale={o.width}:-2'] if o.width else []
    cmd = ['ffmpeg', '-v', 'error', '-y', '-ss', f'{t - off:.3f}', '-i', str(path), '-frames:v', '1', '-q:v', '2']
    if chain:
        cmd += ['-vf', ','.join(chain)]
    run(cmd + [str(out)])
    print(f'{hms(t)}  {out}')

# ---------------- hear (speech recognition) ----------------
def add_cuda_dlls():
    """Make pip-installed NVIDIA DLLs (nvidia-cublas-cu12, nvidia-cudnn-cu12) findable on Windows."""
    if os.name != 'nt':
        return
    import site
    for sp in site.getsitepackages() + [site.getusersitepackages()]:
        base = Path(sp) / 'nvidia'
        if base.exists():
            for b in base.glob('*/bin'):
                try:
                    os.add_dll_directory(str(b))
                except Exception:
                    pass
                os.environ['PATH'] = str(b) + os.pathsep + os.environ.get('PATH', '')

def gpu_ready():
    """CUDA works only if a GPU exists AND cuBLAS/cuDNN can actually be loaded."""
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() < 1:
            return False
        if os.name == 'nt':
            import ctypes
            ctypes.WinDLL('cublas64_12.dll'); ctypes.WinDLL('cudnn_ops64_9.dll')
        return True
    except Exception:
        return False

def load_model(name):
    add_cuda_dlls()
    from faster_whisper import WhisperModel
    if gpu_ready():
        try:
            return WhisperModel(name, device='cuda', compute_type='float16'), 'GPU'
        except Exception:
            pass
    return WhisperModel(name, device='cpu', compute_type='int8', cpu_threads=max(2, (os.cpu_count() or 4) - 1)), 'CPU'

def wav_for(src, a=None, b=None):
    """16 kHz mono WAV of the range (fast to decode for recognition and analysis)."""
    need('ffmpeg')
    path, off = local(src, audio=True)
    wav = path.parent / f'audio{range_tag(a, b)}.wav'
    if not wav.exists():
        cmd = ['ffmpeg', '-v', 'error', '-y']
        if a is not None:
            cmd += ['-ss', f'{a - off:.3f}']
        if b is not None:
            cmd += ['-to', f'{b - off:.3f}']
        run(cmd + ['-i', str(path), '-vn', '-ac', '1', '-ar', '16000', str(wav)])
    return wav, (a or 0.0)

def srt_time(s):
    ms = int(round(s * 1000))
    h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); sec, ms = divmod(ms, 1000)
    return f'{h:02d}:{m:02d}:{sec:02d},{ms:03d}'

def transcribe(src, a=None, b=None, lang=None, model='large-v3-turbo'):
    wav, base = wav_for(src, a, b)
    cache = wav.with_name(wav.stem + f'.{model}.{lang or "auto"}.json')
    if cache.exists():
        return json.loads(cache.read_text(encoding='utf-8')), cache
    t0 = time.time()
    m, dev = load_model(model)
    segs, info = m.transcribe(str(wav), language=lang, vad_filter=True, beam_size=5, word_timestamps=False)
    rows = [{'start': round(s.start + base, 2), 'end': round(s.end + base, 2), 'text': s.text.strip()} for s in segs]
    res = {'language': info.language, 'prob': round(info.language_probability, 2), 'device': dev,
           'seconds': round(time.time() - t0, 1), 'segments': rows}
    cache.write_text(json.dumps(res, ensure_ascii=False), encoding='utf-8')
    srt = cache.with_suffix('.srt')
    srt.write_text(''.join(f"{i}\n{srt_time(r['start'] - base)} --> {srt_time(r['end'] - base)}\n{r['text']}\n\n" for i, r in enumerate(rows, 1)), encoding='utf-8')
    return res, cache

def youtube_subs(url, lang):
    """Prefer human-made subtitles when the site has them (instant, exact)."""
    need('yt-dlp')
    d = workdir(url)
    langs = f'{lang},{lang}-*' if lang else 'uk,ru,en,uk-*,ru-*,en-*'
    run(['yt-dlp', '--no-playlist', '--no-warnings', '-q', '--skip-download', '--write-subs', '--sub-langs', langs,
         '--sub-format', 'vtt', '-o', str(d / 'subs.%(ext)s'), url], check=False)
    vtt = next(iter(sorted(d.glob('subs*.vtt'))), None)
    if not vtt:
        return None
    rows, cur = [], None
    for line in vtt.read_text(encoding='utf-8', errors='replace').splitlines():
        m = re.match(r'([\d:.]+)\s+-->\s+([\d:.]+)', line)
        if m:
            cur = {'start': secs(m.group(1)), 'end': secs(m.group(2)), 'text': ''}
            rows.append(cur)
        elif cur is not None and line.strip() and not line.startswith(('WEBVTT', 'Kind:', 'Language:')):
            cur['text'] = (cur['text'] + ' ' + re.sub(r'<[^>]+>', '', line)).strip()
    return {'language': vtt.stem.split('.')[-1], 'device': 'subtitles', 'segments': [r for r in rows if r['text']]}

def cmd_hear(o):
    a, b = secs(o.from_), secs(o.to)
    res = None
    if o.subs and is_url(o.src):
        res = youtube_subs(o.src, o.lang)
        if res:
            res['segments'] = [r for r in res['segments'] if (a is None or r['end'] >= a) and (b is None or r['start'] <= b)]
    cache = None
    if not res:
        res, cache = transcribe(o.src, a, b, o.lang, o.model)
    segs = res['segments']
    head = f"language: {res['language']} · source: {res['device']}"
    if res.get('seconds') is not None:
        head += f" · recognized in {res['seconds']} s"
    print(head + f' · {len(segs)} segments')
    if cache:
        print(f'srt: {cache.with_suffix(".srt")}')
    if not segs:
        print('(no speech found)')
    for r in segs:
        print(f"[{hms(r['start'])}–{hms(r['end'])}] {r['text']}")

# ---------------- sound (music / non-speech) ----------------
def cmd_sound(o):
    import numpy as np, librosa
    a, b = secs(o.from_), secs(o.to)
    wav, base = wav_for(o.src, a, b)
    y, sr = librosa.load(str(wav), sr=16000, mono=True)
    dur = len(y) / sr
    if dur < 0.2:
        die('audio is too short')
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
    tempo = float(np.atleast_1d(tempo)[0])
    bt = librosa.frames_to_time(beats, sr=sr) + base
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
    db = librosa.amplitude_to_db(rms, ref=np.max(rms) if rms.max() > 0 else 1.0)
    # loudness curve: one char per bucket
    buckets = min(60, max(10, int(dur)))
    chunks = np.array_split(db, buckets)
    bars = '▁▂▃▄▅▆▇█'
    lv = [float(np.mean(c)) if len(c) else -80 for c in chunks]
    lo, hi = min(lv), max(lv)
    curve = ''.join(bars[int((v - lo) / (hi - lo + 1e-9) * (len(bars) - 1))] for v in lv)
    # silences and strongest hits
    intervals = librosa.effects.split(y, top_db=35)
    silences, prev = [], 0
    for s, e in intervals:
        if (s - prev) / sr >= 0.6:
            silences.append((prev / sr + base, s / sr + base))
        prev = e
    if (len(y) - prev) / sr >= 0.6:
        silences.append((prev / sr + base, dur + base))
    env = librosa.onset.onset_strength(y=y, sr=sr)
    peaks = librosa.util.peak_pick(env, pre_max=10, post_max=10, pre_avg=20, post_avg=20, delta=0.5, wait=20)
    peaks = sorted(peaks, key=lambda i: -env[i])[:12]
    hits = sorted(librosa.frames_to_time(peaks, sr=sr) + base)
    cent = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
    print(f'duration {hms(dur + base - base)} ({hms(base)}–{hms(base + dur)}) · tempo ≈ {tempo:.0f} BPM · {len(bt)} beats · brightness {cent:.0f} Hz')
    print(f'loudness ({buckets} steps over the range): {curve}')
    if len(bt):
        print('beats: ' + ' '.join(f'{t:.2f}' for t in bt[:64]) + (' …' if len(bt) > 64 else ''))
    print('strongest hits: ' + (' '.join(f'{hms(t)}' for t in hits) or '—'))
    print('silences: ' + (', '.join(f'{hms(s)}–{hms(e)}' for s, e in silences[:20]) or '—'))

# ---------------- get / edit ----------------
def out_path(o, src_path, suffix, ext):
    if o.out:
        return Path(o.out)
    return Path(src_path).parent / f'{Path(src_path).stem}_{suffix}.{ext}'

def cmd_get(o):
    a, b = secs(o.from_), secs(o.to)
    if not is_url(o.src):
        die('get needs a URL')
    p = download(o.src, audio=o.audio, height=o.height, a=a, b=b)
    print(p)

def cmd_cut(o):
    need('ffmpeg')
    a, b = secs(o.from_), secs(o.to)
    if a is None or b is None:
        die('--from and --to are required')
    path, off = local(o.src, a=a, b=b) if is_url(o.src) else local(o.src)
    out = out_path(o, path, f'{int(a)}-{int(b)}', 'mp4')
    cmd = ['ffmpeg', '-v', 'error', '-y', '-ss', f'{a - off:.3f}', '-to', f'{b - off:.3f}', '-i', str(path)]
    cmd += ['-c', 'copy'] if o.copy else ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k']
    run(cmd + [str(out)])
    print(out)

def cmd_audio(o):
    need('ffmpeg')
    path, _ = local(o.src, audio=True)
    out = out_path(o, path, 'audio', 'mp3')
    run(['ffmpeg', '-v', 'error', '-y', '-i', str(path), '-vn', '-c:a', 'libmp3lame', '-q:a', '2', str(out)])
    print(out)

def cmd_concat(o):
    need('ffmpeg')
    if not o.out:
        die('-o OUT is required')
    files = [local(s)[0] for s in o.files]
    ins = sum([['-i', str(f)] for f in files], [])
    n = len(files)
    parts = ''.join(f'[{i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v{i}];' for i in range(n))
    has_audio = all(probe(f)['audio'] for f in files)
    if has_audio:
        parts += ''.join(f'[v{i}][{i}:a]' for i in range(n)) + f'concat=n={n}:v=1:a=1[v][a]'
        maps = ['-map', '[v]', '-map', '[a]']
    else:
        parts += ''.join(f'[v{i}]' for i in range(n)) + f'concat=n={n}:v=1:a=0[v]'
        maps = ['-map', '[v]']
    run(['ffmpeg', '-v', 'error', '-y', *ins, '-filter_complex', parts, *maps, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', str(o.out)])
    print(o.out)

def cmd_vertical(o):
    need('ffmpeg')
    path, _ = local(o.src)
    out = out_path(o, path, 'vertical', 'mp4')
    vf = 'crop=min(iw\\,ih*9/16):min(ih\\,iw*16/9),scale=1080:1920,setsar=1'
    run(['ffmpeg', '-v', 'error', '-y', '-i', str(path), '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-c:a', 'copy', str(out)])
    print(out)

def cmd_subs(o):
    need('ffmpeg')
    path, _ = local(o.src)
    res, cache = transcribe(str(path), lang=o.lang, model=o.model)
    srt = cache.with_suffix('.srt')
    out = out_path(o, path, 'subs', 'mp4')
    s = srt.as_posix().replace(':', '\\:')
    style = "FontName=Arial,FontSize=18,Outline=2,Shadow=0,MarginV=40"
    run(['ffmpeg', '-v', 'error', '-y', '-i', str(path), '-vf', f"subtitles='{s}':force_style='{style}'",
         '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-c:a', 'copy', str(out)])
    print(out)

def cmd_gif(o):
    need('ffmpeg')
    a, b = secs(o.from_), secs(o.to)
    path, off = local(o.src)
    out = out_path(o, path, f'{int(a or 0)}', 'gif')
    vf = f'fps={o.fps or 12},scale={o.width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse'
    cmd = ['ffmpeg', '-v', 'error', '-y']
    if a is not None:
        cmd += ['-ss', f'{a - off:.3f}']
    if b is not None:
        cmd += ['-to', f'{b - off:.3f}']
    run(cmd + ['-i', str(path), '-vf', vf, str(out)])
    print(out)

def cmd_speed(o):
    need('ffmpeg')
    f = float(o.factor)
    path, _ = local(o.src)
    out = out_path(o, path, f'x{f:g}', 'mp4')
    at, k = [], f
    while k > 2:
        at.append('atempo=2'); k /= 2
    while k < 0.5:
        at.append('atempo=0.5'); k /= 0.5
    at.append(f'atempo={k:g}')
    cmd = ['ffmpeg', '-v', 'error', '-y', '-i', str(path), '-filter:v', f'setpts=PTS/{f}']
    if probe(path)['audio']:
        cmd += ['-filter:a', ','.join(at)]
    run(cmd + ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', str(out)])
    print(out)

# ---------------- cli ----------------
def main():
    ap = argparse.ArgumentParser(prog='media', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)

    def add(name, fn, src=True):
        p = sub.add_parser(name)
        if src:
            p.add_argument('src')
        p.set_defaults(fn=fn)
        return p

    def rng(p):
        p.add_argument('--from', dest='from_')
        p.add_argument('--to')

    add('info', cmd_info)
    p = add('look', cmd_look); rng(p)
    p.add_argument('--fps', type=float); p.add_argument('--every', type=float); p.add_argument('--scenes', action='store_true')
    p.add_argument('--threshold', type=float, default=0.3); p.add_argument('--max', type=int, default=24)
    p.add_argument('--width', type=int, default=512); p.add_argument('--cols', type=int, default=3)
    p.add_argument('--grid', dest='grid', action='store_true', default=None); p.add_argument('--nogrid', dest='grid', action='store_false')
    p.add_argument('--force', action='store_true')
    p.add_argument('--section', action='store_true', help='download only the range (long videos)')
    p = add('frame', cmd_frame); p.add_argument('time'); p.add_argument('--width', type=int, default=0)
    p = add('hear', cmd_hear); rng(p); p.add_argument('--lang'); p.add_argument('--model', default='large-v3-turbo'); p.add_argument('--subs', action='store_true')
    p = add('sound', cmd_sound); rng(p)
    p = add('get', cmd_get); rng(p); p.add_argument('--audio', action='store_true'); p.add_argument('--height', type=int, default=1080)
    p = add('cut', cmd_cut); rng(p); p.add_argument('-o', dest='out'); p.add_argument('--copy', action='store_true')
    p = add('audio', cmd_audio); p.add_argument('-o', dest='out')
    p = add('concat', cmd_concat, src=False); p.add_argument('files', nargs='+'); p.add_argument('-o', dest='out')
    p = add('vertical', cmd_vertical); p.add_argument('-o', dest='out')
    p = add('subs', cmd_subs); p.add_argument('-o', dest='out'); p.add_argument('--lang'); p.add_argument('--model', default='large-v3-turbo')
    p = add('gif', cmd_gif); rng(p); p.add_argument('-o', dest='out'); p.add_argument('--width', type=int, default=480); p.add_argument('--fps', type=float)
    p = add('speed', cmd_speed); p.add_argument('factor'); p.add_argument('-o', dest='out')

    o = ap.parse_args()
    o.fn(o)

if __name__ == '__main__':
    main()
