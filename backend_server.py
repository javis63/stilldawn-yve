#!/usr/bin/env python3
"""
YouTube Video Engine - Backend Server
Handles UI requests, file uploads, rendering coordination, and notifications
"""

from flask import Flask, request, jsonify, send_file, send_from_directory
from flask_cors import CORS
import json
import logging
import os
import subprocess
import sys
import threading
import time
import traceback
import re
import shutil
import uuid
import requests
from pathlib import Path
from datetime import datetime
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from werkzeug.utils import secure_filename

# Force unbuffered stdout/stderr so logs appear immediately on VPS
if not sys.stdout.line_buffering:
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)

# Structured logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
    stream=sys.stdout,
)
logger = logging.getLogger('yve-render')

app = Flask(__name__)
CORS(app)

# Configuration
BASE_DIR = Path(__file__).parent
UPLOAD_DIR = BASE_DIR / 'uploads'
OUTPUT_DIR = BASE_DIR / 'output'
CONFIG_FILE = BASE_DIR / 'config.json'

# Lovable render endpoint auth (used only for /api/lovable-render*)
VPS_API_KEY = "OZEiHTtn4exZrBXMdA3UDKyODupExRDW3Q3mDSgL4125e637"

# Ensure directories exist
(UPLOAD_DIR / 'audio').mkdir(parents=True, exist_ok=True)
(UPLOAD_DIR / 'media').mkdir(parents=True, exist_ok=True)
(UPLOAD_DIR / 'temp').mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

# Temp folder for Lovable render jobs
LOVABLE_TEMP_DIR = UPLOAD_DIR / 'temp' / 'lovable'
LOVABLE_TEMP_DIR.mkdir(parents=True, exist_ok=True)

# Track Lovable render jobs (separate from existing render_status)
lovable_render_jobs = {}


# Project-level audio helpers (project-scoped uploads)
def _project_audio_dir(project_id: str) -> Path:
    return UPLOAD_DIR / 'audio' / str(project_id)

def _audio_rel_path(project_id: str, filename: str) -> str:
    # store as relative path for portability in JSON
    return f"uploads/audio/{project_id}/{filename}"

def _load_project_file_and_data(project_key: str):
    """Return (Path, data dict) for a given project id/key, or (None, None)."""
    fp = _resolve_project_file(project_key)
    if not fp:
        return None, None
    try:
        data = json.loads(fp.read_text(encoding="utf-8"))
    except Exception:
        return fp, None
    return fp, data

def _save_project_data(fp: Path, data: dict):
    """Atomic write for project JSON."""
    tmp = fp.with_suffix(fp.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, fp)



def _scene_dir(project_id, scene_number):
    return UPLOAD_DIR / 'media' / project_id / f"scene_{scene_number}"

def _manifest_path(project_id, scene_number):
    return _scene_dir(project_id, scene_number) / "manifest.json"

def _load_manifest(project_id, scene_number):
    mp = _manifest_path(project_id, scene_number)
    if mp.exists():
        try:
            return json.loads(mp.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}

def _save_manifest(project_id, scene_number, data):
    sd = _scene_dir(project_id, scene_number)
    sd.mkdir(parents=True, exist_ok=True)
    mp = _manifest_path(project_id, scene_number)
    mp.write_text(json.dumps(data, indent=2), encoding="utf-8")

def _ffprobe_duration_seconds(path: Path):
    try:
        # Requires ffprobe (ffmpeg). If missing, return None.
        res = subprocess.run(
            ["ffprobe","-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, check=False
        )
        out = (res.stdout or "").strip()
        if not out:
            return None
        return float(out)
    except Exception:
        return None


# Global state
render_status = {
    'active': False,
    'progress': 0,
    'current_task': '',
    'scenes': [],
    'complete': False,
    'error': None,
    'start_time': None
}

generation_status = {
    'active': False,
    'progress': 0,
    'current_task': '',
    'complete': False,
    'error': None
}

def load_config():
    if CONFIG_FILE.exists():
        with open(CONFIG_FILE, 'r') as f:
            return json.load(f)
    return {
        'email': 'jjv6363@gmail.com',
        'phone': '5856132293',
        'notify_complete': True,
        'notify_error': True
    }

def save_config(config):
    with open(CONFIG_FILE, 'w') as f:
        json.dump(config, f, indent=2)

def send_email(to_email, subject, body):
    try:
        msg = MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['From'] = 'YVE <noreply@yve.local>'
        msg['To'] = to_email
        
        html = f"""<html><body style="font-family: Arial;">
        <h2 style="color: #FF0000;">🎬 YouTube Video Engine</h2>
        {body}
        </body></html>"""
        
        msg.attach(MIMEText(body, 'plain'))
        msg.attach(MIMEText(html, 'html'))
        
        with smtplib.SMTP('localhost') as server:
            server.send_message(msg)
        return True
    except Exception as e:
        print(f"Email failed: {e}")
        return False

def send_sms(phone, message):
    try:
        phone_clean = ''.join(filter(str.isdigit, phone))
        sms_email = phone_clean + '@vtext.com'  # Verizon gateway
        
        msg = MIMEText(message[:160])
        msg['From'] = 'YVE'
        msg['To'] = sms_email
        
        with smtplib.SMTP('localhost') as server:
            server.send_message(msg)
        return True
    except Exception as e:
        print(f"SMS failed: {e}")
        return False

# --- Project name guard ---
FORBIDDEN_PROJECT_NAMES = {'next', 'prev', 'previous', 'continue'}

def sanitize_project_name(name: str) -> str:
    if not name:
        return ''
    n = name.strip()
    if n.lower() in FORBIDDEN_PROJECT_NAMES:
        raise ValueError(f"Invalid project name: '{n}'")
    return n


# --- Lovable render auth helper ---
def verify_lovable_api_key() -> bool:
    """Verify API key for /api/lovable-render* endpoints only."""
    auth_header = request.headers.get('Authorization', '')
    if not auth_header.startswith('Bearer '):
        return False
    return auth_header[7:] == VPS_API_KEY


@app.route('/')
def index():
    # Serve React frontend if dist exists, otherwise fallback to old dashboard
    dist_index = BASE_DIR / 'dist' / 'index.html'
    if dist_index.exists():
        return send_file(dist_index)
    return send_file('yve_dashboard.html')

@app.route('/assets/<path:filename>')
def serve_assets(filename):
    """Serve React frontend static assets."""
    return send_from_directory(BASE_DIR / 'dist' / 'assets', filename)

@app.route('/api/transcribe-and-analyze', methods=['POST'])
def transcribe_and_analyze():
    """Step 1: Upload audio, transcribe, and generate scene breakdown"""
    global generation_status
    
    try:
        audio_file = request.files.get('audio')
        if not audio_file:
            return jsonify({'success': False, 'error': 'No audio file provided'})
        
        # Save audio
        audio_path = UPLOAD_DIR / 'audio' / audio_file.filename
        audio_file.save(audio_path)
        
        generation_status = {
            'active': True,
            'progress': 10,
            'current_task': 'Transcribing audio...',
            'complete': False,
            'error': None
        }
        
        # Run transcription and analysis in background
        def process():
            global generation_status
            try:
                import sys
                sys.path.insert(0, str(BASE_DIR))
                from asset_generator import AssetGenerator
                
                generator = AssetGenerator(str(audio_path), str(UPLOAD_DIR / 'temp'))
                
                def progress_callback(msg):
                    generation_status['current_task'] = msg
                    if 'Transcribing' in msg:
                        generation_status['progress'] = 30
                    elif 'Analyzing' in msg:
                        generation_status['progress'] = 60
                
                result = generator.run_full_pipeline(progress_callback)
                
                generation_status['progress'] = 100
                generation_status['complete'] = True
                generation_status['scenes'] = result['scenes']
                generation_status['transcript'] = result['transcript']['text']
                
            except Exception as e:
                import traceback
                generation_status['error'] = str(e)
                generation_status['trace'] = traceback.format_exc()
                print(f"Error: {e}")
                print(traceback.format_exc())
            finally:
                generation_status['active'] = False
        
        threading.Thread(target=process).start()
        
        return jsonify({'success': True, 'message': 'Processing started'})
        
    except Exception as e:
        import traceback
        return jsonify({'success': False, 'error': str(e), 'trace': traceback.format_exc()})

@app.route('/api/save-project-json', methods=['POST'])
def save_project_json():
    """Save project JSON directly without processing"""
    try:
        data = request.json
        scenes = data.get('scenes', [])
        project_name = data.get('project_name', 'custom_project')
        
        if not scenes or len(scenes) == 0:
            return jsonify({'success': False, 'error': 'No scenes provided'})
        
        # Create project file
        timestamp = int(time.time())
        projects_dir = BASE_DIR / 'projects'
        projects_dir.mkdir(exist_ok=True)
        project_file = projects_dir / f"{timestamp}_{project_name}.json"
        
        project_data = {
            'project_name': project_name,
            'created_at': timestamp,
            'scenes': scenes,
            'transcript': ' '.join([s.get('narration_text', '') for s in scenes])
        }
        
        with open(project_file, 'w') as f:
            json.dump(project_data, f, indent=2)
        
        return jsonify({
            'success': True,
            'project_id': f"{timestamp}_{project_name}",
            'scene_count': len(scenes)
        })
        
    except Exception as e:
        import traceback
        return jsonify({'success': False, 'error': str(e), 'trace': traceback.format_exc()})

@app.route('/api/analyze-transcript', methods=['POST'])
def analyze_transcript():
    """Analyze pasted transcript without audio upload"""
    global generation_status
    
    try:
        data = request.json
        transcript = data.get('transcript', '')
        
        if not transcript or len(transcript) < 100:
            return jsonify({'success': False, 'error': 'Transcript too short'})
        
        generation_status = {
            'active': True,
            'progress': 30,
            'current_task': 'Analyzing transcript with Claude...',
            'complete': False,
            'error': None
        }
        
        # Run analysis in background
        def process():
            global generation_status
            try:
                import anthropic
                
                generation_status['progress'] = 60
                generation_status['current_task'] = 'Generating scene breakdown...'
                
                client = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))
                
                response = client.messages.create(
                    model="claude-sonnet-4-20250514",
                    max_tokens=16000,
                    messages=[{
                        "role": "user",
                        "content": f"""Analyze this narration transcript and break it into scenes for video production.

For each scene, provide:
- scene_number (sequential)
- duration (8-12 seconds for images, 6 for action videos)
- scene_type ("image" for static scenes, "video" for action/movement)
- prompt (detailed Flux AI image generation prompt - be specific about camera angles, lighting, composition. When mentioning soldiers, operators, or military personnel, specify "American" or "US")
- narration_text (the exact text from this scene)

Transcript:
{transcript}

Return ONLY a JSON array of scenes, no other text."""
                    }]
                )
                
                scenes_json = response.content[0].text.strip()
                # Remove markdown code blocks if present
                if scenes_json.startswith('```'):
                    scenes_json = scenes_json.split('```')[1]
                    if scenes_json.startswith('json'):
                        scenes_json = scenes_json[4:]
                    scenes_json = scenes_json.strip()
                
                scenes = json.loads(scenes_json)
                
                # Save scenes to temp
                scenes_file = UPLOAD_DIR / 'temp' / 'scenes.json'
                with open(scenes_file, 'w') as f:
                    json.dump(scenes, f, indent=2)
                
                generation_status['progress'] = 100
                generation_status['complete'] = True
                generation_status['scenes'] = scenes
                generation_status['transcript'] = transcript
                
            except Exception as e:
                import traceback
                generation_status['error'] = str(e)
                generation_status['trace'] = traceback.format_exc()
                print(f"Error: {e}")
                print(traceback.format_exc())
            finally:
                generation_status['active'] = False
        
        threading.Thread(target=process).start()
        
        return jsonify({'success': True, 'message': 'Analysis started'})
        
    except Exception as e:
        import traceback
        return jsonify({'success': False, 'error': str(e), 'trace': traceback.format_exc()})

@app.route('/api/generation-status')
def get_generation_status():
    """Get status of transcription/scene analysis"""
    return jsonify(generation_status)

@app.route('/api/generate-assets', methods=['POST'])
def generate_assets():
    """Step 2: Generate images/videos from approved scenes"""
    global generation_status
    
    try:
        scenes = request.json.get('scenes', [])
        
        generation_status = {
            'active': True,
            'progress': 0,
            'current_task': 'Starting asset generation...',
            'complete': False,
            'error': None
        }
        
        def process():
            global generation_status
            try:
                import sys
                sys.path.insert(0, str(BASE_DIR))
                from asset_generator import AssetGenerator
                
                generator = AssetGenerator(None, str(UPLOAD_DIR / 'media'))
                
                def progress_callback(msg):
                    generation_status['current_task'] = msg
                
                results = generator.generate_all_assets(scenes, progress_callback)
                
                generation_status['progress'] = 100
                generation_status['complete'] = True
                generation_status['assets'] = results
                
                # Save project
                try:
                    import time
                    projects_dir = BASE_DIR / 'projects'
                    projects_dir.mkdir(exist_ok=True)
                    
                    # Get audio filename from most recent file
                    audio_files = list((UPLOAD_DIR / 'audio').glob('*'))
                    audio_name = audio_files[-1].stem if audio_files else 'Untitled'
                    
                    # Load transcript
                    transcript_file = UPLOAD_DIR / 'temp' / 'scenes.json'
                    transcript_text = ''
                    if transcript_file.exists():
                        with open(transcript_file, 'r') as f:
                            scene_data = json.load(f)
                            transcript_text = ' '.join([s.get('narration_text', '') for s in scene_data])
                    
                    # Merge scene data with generated assets
                    for scene in scenes:
                        for asset in results:
                            if scene['scene_number'] == asset['scene_number']:
                                scene['image_path'] = asset['asset_path']
                                break
                    
                    project_data = {
                        'name': audio_name,
                        'created': time.strftime('%Y-%m-%d %H:%M:%S'),
                        'transcript': transcript_text,
                        'scenes': scenes,
                        'assets': results
                    }
                    
                    project_id = f"{int(time.time())}_{audio_name.replace(' ', '_')}"
                    with open(projects_dir / f'{project_id}.json', 'w') as f:
                        json.dump(project_data, f, indent=2)
                    
                    print(f"Project saved: {project_id}")
                except Exception as e:
                    print(f"Error saving project: {e}")
                
            except Exception as e:
                import traceback
                generation_status['error'] = str(e)
                generation_status['trace'] = traceback.format_exc()
                print(f"Error: {e}")
                print(traceback.format_exc())
            finally:
                generation_status['active'] = False
        
        threading.Thread(target=process).start()
        
        return jsonify({'success': True, 'message': 'Asset generation started'})
        
    except Exception as e:
        import traceback
        return jsonify({'success': False, 'error': str(e), 'trace': traceback.format_exc()})

@app.route('/api/generate-work-order', methods=['POST'])
def generate_work_order():
    try:
        story_data = request.json
        
        total_scenes = 0
        video_count = 0
        image_count = 0
        
        for act in story_data.get('acts', []):
            scenes = act.get('scenes', [])
            total_scenes += len(scenes)
            video_count += sum(1 for s in scenes if s.get('scene_type') == 'video')
            image_count += sum(1 for s in scenes if s.get('scene_type') == 'image')
        
        work_order_path = OUTPUT_DIR / 'Work_Order.txt'
        
        with open(work_order_path, 'w') as f:
            f.write("=" * 80 + "\n")
            f.write("YOUTUBE VIDEO ENGINE - WORK ORDER\n")
            f.write("=" * 80 + "\n\n")
            f.write(f"Story: {story_data['story_title']}\n")
            f.write(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")
            f.write(f"Total Scenes: {total_scenes}\n")
            f.write(f"Videos: {video_count} | Images: {image_count}\n\n")
            f.write("=" * 80 + "\n\n")
            
            for act in story_data.get('acts', []):
                f.write(f"\nACT {act['act_number']}: {act['act_title']}\n")
                f.write("=" * 80 + "\n\n")
                
                f.write("NATURALREADER SCRIPTS:\n")
                f.write("-" * 80 + "\n\n")
                
                for scene in act.get('scenes', []):
                    num = scene['scene_number']
                    f.write(f"SCENE {num} ({scene['duration']}s) → act{act['act_number']}_scene{num}.mp3\n")
                    f.write("-" * 80 + "\n")
                    f.write(scene.get('scene_script', '') + "\n\n")
                
                f.write("\nGROK MEDIA PROMPTS:\n")
                f.write("-" * 80 + "\n\n")
                
                for scene in act.get('scenes', []):
                    num = scene['scene_number']
                    ext = 'mp4' if scene['scene_type'] == 'video' else 'jpg'
                    f.write(f"SCENE {num} [{scene['scene_type'].upper()}] → act{act['act_number']}_scene{num}.{ext}\n")
                    f.write(f"Prompt: {scene.get('scene_description', '')}\n\n")
        
        return jsonify({
            'success': True,
            'pdf_url': '/output/Work_Order.txt',
            'total_scenes': total_scenes,
            'video_count': video_count,
            'image_count': image_count
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/start-render', methods=['POST'])
def start_render():
    global render_status
    
    try:
        audio_files = request.files.getlist('audio')
        media_files = request.files.getlist('media')
        story_json = request.form.get('story')
        video_audio_volume = float(request.form.get('video_audio_volume', 0.15))
        
        # Clear old uploads
        for f in (UPLOAD_DIR / 'audio').glob('*'):
            f.unlink()
        for f in (UPLOAD_DIR / 'media').glob('*'):
            f.unlink()
        
        # Save uploads
        for audio in audio_files:
            audio.save(UPLOAD_DIR / 'audio' / audio.filename)
        for media in media_files:
            media.save(UPLOAD_DIR / 'media' / media.filename)
        
        # Save JSON - wrap in proper structure for engine
        if story_json:
            story_data = json.loads(story_json)
            
            # Calculate total duration from scenes
            total_duration = sum(scene.get('duration', 90) for scene in story_data.get('scenes', []))
            
            # Wrap in engine-expected format
            wrapped_data = {
                'story_title': story_data.get('story_title', 'Untitled'),
                'story_description': story_data.get('story_description', ''),
                'story_keywords': story_data.get('story_keywords', '').split(', ') if story_data.get('story_keywords') else [],
                'acts': [
                    {
                        'act_number': story_data.get('act_number', 1),
                        'act_title': story_data.get('act_title', 'Act 1'),
                        'duration_seconds': total_duration,
                        'scenes': story_data.get('scenes', [])
                    }
                ]
            }
            
            json_path = BASE_DIR / 'current_story.json'
            with open(json_path, 'w') as f:
                json.dump(wrapped_data, f, indent=2)
        
        # Save render settings
        settings_path = BASE_DIR / 'render_settings.json'
        with open(settings_path, 'w') as f:
            json.dump({'video_audio_volume': video_audio_volume}, f)
        
        render_status = {
            'active': True,
            'progress': 0,
            'current_task': 'Starting...',
            'scenes': [],
            'complete': False,
            'error': None,
            'start_time': datetime.now()
        }
        
        threading.Thread(target=run_render).start()
        
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

def run_render():
    global render_status
    
    try:
        cmd = [
            'python3',
            str(BASE_DIR / 'youtube_video_engine.py'),
            str(BASE_DIR / 'current_story.json'),
            str(UPLOAD_DIR / 'audio'),
            str(UPLOAD_DIR / 'media'),
            str(OUTPUT_DIR)
        ]
        
        process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        
        for line in process.stdout:
            print(line.strip())
            if 'Scene' in line:
                try:
                    parts = line.split()
                    if 'of' in parts:
                        idx = parts.index('of')
                        current = int(parts[idx-1])
                        total = int(parts[idx+1])
                        render_status['progress'] = (current / total) * 100
                        render_status['current_task'] = f"Scene {current}/{total}"
                except:
                    pass
        
        process.wait()
        
        if process.returncode == 0:
            render_status['complete'] = True
            render_status['progress'] = 100
            
            config = load_config()
            video_files = list(OUTPUT_DIR.glob('*.mp4'))
            
            if video_files and config.get('notify_complete'):
                video = video_files[0]
                size_mb = video.stat().st_size / (1024 * 1024)
                elapsed = datetime.now() - render_status['start_time']
                time_str = f"{int(elapsed.total_seconds()//60)}m"
                
                send_email(config['email'], f"✅ {video.stem} Complete!", 
                          f"<p>Render: {time_str} | Size: {size_mb:.1f}MB</p>")
                send_sms(config['phone'], f"✅ Video done! {video.stem[:30]}")
        else:
            error = process.stderr.read()
            render_status['error'] = error
            config = load_config()
            if config.get('notify_error'):
                send_email(config['email'], "⚠️ Render Error", error)
    except Exception as e:
        render_status['error'] = str(e)
    finally:
        render_status['active'] = False

@app.route('/api/progress')
def get_progress():
    return jsonify(render_status)

@app.route('/api/settings', methods=['POST'])
def save_settings_route():
    try:
        save_config(request.json)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/test-notification')
def test_notification():
    try:
        config = load_config()
        send_email(config['email'], "🎬 YVE Test", "<p>Notifications working!</p>")
        send_sms(config['phone'], "YVE test: Working!")
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/output/<path:filename>')
def download_file(filename):
    return send_from_directory(OUTPUT_DIR, filename)


@app.route('/api/video/<project_id>/<render_id>', methods=['GET'])
def serve_video(project_id, render_id):
    """Serve rendered videos from the VPS output directory."""
    video_path = OUTPUT_DIR / str(project_id) / f"{render_id}.mp4"
    if video_path.exists():
        return send_file(str(video_path), mimetype='video/mp4')
    return jsonify({'error': 'Video not found'}), 404


@app.route('/api/project/<project_id>/scene/<scene_number>/upload-media', methods=['POST'])
def upload_scene_media(project_id, scene_number):
    try:
        media = request.files.get('media')
        if not media:
            return jsonify({'success': False, 'error': 'No media file provided'}), 400

        kind = (request.args.get('kind') or request.form.get('kind') or '').strip().lower()
        # kind can be: image | video | auto
        if kind not in ('image','video','auto',''):
            return jsonify({'success': False, 'error': 'Invalid kind. Use image or video.'}), 400
        if kind in ('', 'auto'):
            # Infer by extension (default to image)
            fn = (media.filename or '').lower()
            if fn.endswith(('.mp4','.mov','.webm','.m4v','.avi')):
                kind = 'video'
            else:
                kind = 'image'

        scene_dir = _scene_dir(project_id, scene_number)
        scene_dir.mkdir(parents=True, exist_ok=True)

        filename = media.filename
        save_path = scene_dir / filename
        media.save(save_path)

        manifest = _load_manifest(project_id, scene_number)
        manifest.setdefault('scene_number', str(scene_number))
        manifest.setdefault('project_id', str(project_id))
        manifest.setdefault('updated_at', datetime.utcnow().isoformat() + 'Z')

        entry = {'filename': filename, 'url': f"/media/{project_id}/scene_{scene_number}/{filename}"}

        if kind == 'video':
            dur = _ffprobe_duration_seconds(save_path)
            if dur is not None:
                entry['duration_seconds'] = dur

        manifest[kind] = entry
        _save_manifest(project_id, scene_number, manifest)

        return jsonify({'success': True, 'kind': kind, 'filename': filename, 'media_url': entry['url'], 'duration_seconds': entry.get('duration_seconds')})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500



@app.route('/api/project/<project_id>/scene/<scene_number>/media', methods=['GET'])
def get_scene_media(project_id, scene_number):
    try:
        manifest = _load_manifest(project_id, scene_number)
        return jsonify({'success': True, 'media': manifest})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/project/<project_id>/scene/<scene_number>/delete-media', methods=['POST'])
def delete_scene_media(project_id, scene_number):
    try:
        data = request.get_json(silent=True) or {}
        kind = (data.get('kind') or '').strip().lower()
        if kind not in ('image','video'):
            return jsonify({'success': False, 'error': 'kind must be image or video'}), 400

        manifest = _load_manifest(project_id, scene_number)
        entry = manifest.get(kind) or {}
        filename = entry.get('filename')
        if filename:
            fp = _scene_dir(project_id, scene_number) / filename
            try:
                if fp.exists():
                    fp.unlink()
            except Exception:
                pass

        if kind in manifest:
            manifest.pop(kind, None)
            manifest['updated_at'] = datetime.utcnow().isoformat() + 'Z'
            _save_manifest(project_id, scene_number, manifest)

        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/media/<path:filename>')
def serve_media(filename):
    return send_from_directory(UPLOAD_DIR / 'media', filename)


@app.route('/api/project/create-from-audio', methods=['POST'])
def create_project_from_audio():
    # Create a brand-new project and attach the uploaded narration audio.
    # This endpoint NEVER modifies an existing project.
    try:
        audio_file = request.files.get('audio')
        if not audio_file:
            return jsonify({'success': False, 'error': 'No audio file provided'}), 400

        raw_name = (request.form.get('name') or '').strip()
        if not raw_name:
            raw_name = Path(audio_file.filename).stem or 'New_Audio_Project'

        project_name = sanitize_project_name(raw_name)
        ts = int(time.time())
        safe_name = re.sub(r'[^A-Za-z0-9_\-]+', '_', project_name).strip('_')
        project_id = f"{ts}_{safe_name}"

        projects_dir = BASE_DIR / 'projects'
        projects_dir.mkdir(exist_ok=True)

        # Save audio in legacy flat folder for compatibility (uploads/audio/<filename>)
        audio_dir = UPLOAD_DIR / 'audio'
        audio_dir.mkdir(parents=True, exist_ok=True)
        audio_fn = secure_filename(audio_file.filename) or 'narration.mp3'
        audio_path = audio_dir / audio_fn
        audio_file.save(audio_path)

        project_data = {
            'id': project_id,
            'name': project_name,
            'created_at': ts,
            'created': ts,
            'audio_filename': audio_fn,
            'audio_path': str(Path('uploads') / 'audio' / audio_fn).replace('\\', '/'),
            'scenes': [],
            'transcript': ''
        }

        with open(projects_dir / f"{project_id}.json", 'w', encoding='utf-8') as f:
            json.dump(project_data, f, indent=2)

        return jsonify({'success': True, 'project_id': project_id, 'audio_filename': audio_fn})
    except Exception as e:
        import traceback
        return jsonify({'success': False, 'error': str(e), 'trace': traceback.format_exc()}), 500


@app.route('/api/list-output', methods=['GET'])
def list_output():
    # List rendered video files in the output directory.
    try:
        exts = {'.mp4', '.mov', '.m4v', '.webm'}
        files = []
        if OUTPUT_DIR.exists():
            for p in OUTPUT_DIR.iterdir():
                if p.is_file() and p.suffix.lower() in exts:
                    st = p.stat()
                    files.append({
                        'filename': p.name,
                        'size': st.st_size,
                        'mtime': int(st.st_mtime),
                        'url': f"/output/{p.name}"
                    })
        files.sort(key=lambda x: x['mtime'], reverse=True)
        return jsonify({'success': True, 'files': files})
    except Exception as e:
        import traceback
        return jsonify({'success': False, 'error': str(e), 'trace': traceback.format_exc()}), 500

@app.route('/api/list-projects', methods=['GET'])
def list_projects():
    projects_dir = BASE_DIR / 'projects'
    projects = []
    if projects_dir.exists():
        for pf in projects_dir.glob('*.json'):
            # Hide junk/command-named projects from UI
            if pf.stem.endswith('_next') or pf.stem.endswith('_continue'):
                continue
            try:
                data = json.loads(pf.read_text(encoding='utf-8'))
                stem = pf.stem
                created = 0
                try:
                    created = int(stem.split('_', 1)[0])
                except Exception:
                    try:
                        created = int(data.get('created', 0) or 0)
                    except Exception:
                        created = 0

                scenes = data.get('scenes', []) or []
                image_count = 0
                for s in scenes:
                    try:
                        if (s.get('scene_type') == 'image'):
                            image_count += 1
                    except Exception:
                        pass

                name = data.get('name', stem)
                if str(name).strip().lower() in FORBIDDEN_PROJECT_NAMES:
                    continue
                proj_id = stem
                projects.append({
                    'created': created,
                    'id': proj_id,
                    'name': name,
                    'scene_count': len(scenes),
                    'image_count': image_count
                })
            except Exception:
                pass

    projects.sort(key=lambda x: int(x.get("created") or 0), reverse=True)
    return jsonify({'success': True, 'projects': projects})




def _resolve_project_file(key: str):
    projects_dir = BASE_DIR / "projects"
    # direct match by stem
    fp = projects_dir / f"{key}.json"
    if fp.exists():
        return fp

    # try matching by JSON id/name
    if projects_dir.exists():
        for cand in projects_dir.glob("*.json"):
            try:
                data = json.loads(cand.read_text(encoding="utf-8"))
            except Exception:
                continue
            if data.get("id") == key or data.get("name") == key or cand.stem == key:
                return cand

    return None



# ============================================
# Create Project (explicit user action)
# ============================================
@app.route('/api/create-project', methods=['POST'])
def create_project():
    try:
        payload = request.get_json(silent=True) or {}
        name = payload.get('name') or payload.get('project_name') or 'New Project'
        # Guard names that conflict with navigation
        if str(name).strip().lower() in FORBIDDEN_PROJECT_NAMES:
            return jsonify({'success': False, 'error': 'Invalid project name'}), 400
        safe_name = str(name).strip().replace('\n',' ').replace('\r',' ')
        ts = int(time.time())
        projects_dir = BASE_DIR / 'projects'
        projects_dir.mkdir(exist_ok=True)
        project_id = f"{ts}_{safe_name.replace(' ', '_')}"
        fp = projects_dir / f"{project_id}.json"
        data = {
            "id": project_id,
            "name": safe_name,
            "created": ts,
            "transcript": "",
            "scenes": [],
            "assets": []
        }
        _save_project_data(fp, data)
        return jsonify({'success': True, 'id': project_id, 'name': safe_name})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# ============================================
# Project-level Audio (MP3) Upload / Delete
# ============================================

@app.route('/api/project/<project_id>/upload-audio', methods=['POST'])
def upload_project_audio(project_id):
    """Upload/replace the project's narration audio (typically MP3)."""
    try:
        fp, data = _load_project_file_and_data(project_id)
        if not fp:
            return jsonify({'success': False, 'error': 'project not found'}), 404
        if data is None:
            return jsonify({'success': False, 'error': 'invalid project json'}), 500

        audio_file = request.files.get('audio') or request.files.get('file')
        if not audio_file or not getattr(audio_file, 'filename', ''):
            return jsonify({'success': False, 'error': 'No audio file provided (field name: audio)'}), 400

        filename = secure_filename(audio_file.filename) or 'narration.mp3'
        lower = filename.lower()
        if not lower.endswith(('.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg')):
            return jsonify({'success': False, 'error': 'Unsupported audio type. Upload mp3/wav/m4a/aac/flac/ogg.'}), 400

        adir = _project_audio_dir(project_id)
        adir.mkdir(parents=True, exist_ok=True)

        dest = adir / filename
        tmp = adir / (filename + '.uploading')
        audio_file.save(tmp)
        os.replace(tmp, dest)

        rel_path = _audio_rel_path(project_id, filename)
        url = f"/audio/{project_id}/{filename}"

        # Backwards-compatible + forward structure
        data['audio_path'] = rel_path
        data.setdefault('audio', {})
        data['audio']['filename'] = filename
        data['audio']['path'] = rel_path
        data['audio']['url'] = url
        data['audio']['uploaded_at'] = datetime.utcnow().isoformat() + 'Z'

        _save_project_data(fp, data)

        return jsonify({'success': True, 'filename': filename, 'audio_path': rel_path, 'audio_url': url})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/project/<project_id>/delete-audio', methods=['POST'])
def delete_project_audio(project_id):
    """Delete the project's narration audio file and clear metadata."""
    try:
        fp, data = _load_project_file_and_data(project_id)
        if not fp:
            return jsonify({'success': False, 'error': 'project not found'}), 404
        if data is None:
            return jsonify({'success': False, 'error': 'invalid project json'}), 500

        filename = None
        if isinstance(data.get('audio'), dict):
            filename = data['audio'].get('filename')
        if not filename and data.get('audio_path'):
            try:
                filename = Path(str(data.get('audio_path'))).name
            except Exception:
                filename = None

        if filename:
            fp_audio = _project_audio_dir(project_id) / filename
            try:
                if fp_audio.exists():
                    fp_audio.unlink()
            except Exception:
                pass

        data.pop('audio_path', None)
        if isinstance(data.get('audio'), dict):
            data.pop('audio', None)

        _save_project_data(fp, data)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/audio/<project_id>/<path:filename>')
def serve_project_audio(project_id, filename):
    """Serve uploaded project audio."""
    return send_from_directory(_project_audio_dir(project_id), filename)



@app.route("/api/project/<key>", methods=["GET"])
def get_project(key):
    fp = _resolve_project_file(key)
    if not fp:
        return jsonify({"success": False, "error": "project not found"}), 404
    try:
        data = json.loads(fp.read_text(encoding="utf-8"))
    except Exception as e:
        return jsonify({"success": False, "error": f"invalid project json: {e}"}), 500
    return jsonify({"success": True, "project": data, "id": data.get("id", fp.stem), "name": data.get("name", fp.stem)})

@app.route('/api/project/<project_id>/transcribe', methods=['POST'])
def project_transcribe_whisper(project_id):
    """Transcribe existing project audio and save transcript into project JSON"""
    try:
        project_path = BASE_DIR / 'projects' / f"{project_id}.json"
        if not project_path.exists():
            return jsonify({'success': False, 'error': 'Project not found'}), 404

        project = json.loads(project_path.read_text(encoding='utf-8'))
        audio_rel = project.get('audio_path', '')
        if not audio_rel:
            return jsonify({'success': False, 'error': 'Project has no audio_path'}), 400

        audio_path = BASE_DIR / audio_rel
        if not audio_path.exists():
            return jsonify({'success': False, 'error': 'Audio file missing'}), 400

        from asset_generator import AssetGenerator
        generator = AssetGenerator(str(audio_path), str(UPLOAD_DIR / 'temp'))

        result = generator.transcribe_audio()

        transcript_text = ''
        if isinstance(result, dict):
            transcript_text = (
                result.get('text')
                or (result.get('transcript') or {}).get('text')
                or result.get('transcription')
                or ''
            )
        else:
            transcript_text = getattr(result, 'text', '') or str(result)

        project['transcript'] = transcript_text
        project_path.write_text(json.dumps(project, indent=2), encoding='utf-8')

        return jsonify({'success': True, 'transcript_len': len(transcript_text)})

    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# =============================================================================
# ASS SUBTITLE GENERATION
# =============================================================================

def _generate_ass_subtitles(word_timestamps, output_path, log=None):
    """
    Generate an ASS subtitle file from word timestamps.

    Args:
        word_timestamps: List of dicts with {word, start, end} (times in seconds)
        output_path: Path to write the .ass file
        log: Optional logger

    Returns:
        True if subtitles were generated, False otherwise
    """
    if not word_timestamps or len(word_timestamps) == 0:
        if log:
            log.info("No word timestamps provided, skipping subtitle generation")
        return False

    # Group words into subtitle chunks (similar to frontend logic)
    def group_words(words, max_words=6, max_chars=40, max_duration=3.5):
        subtitles = []
        current_words = []
        current_text = ''

        for w in words:
            word_text = (w.get('word') or '').strip()
            if not word_text:
                continue

            test_text = f"{current_text} {word_text}".strip() if current_text else word_text
            current_duration = (w['end'] - current_words[0]['start']) if current_words else 0

            # Check if we should start a new subtitle
            should_break = (
                len(current_words) >= max_words or
                len(test_text) > max_chars or
                current_duration > max_duration or
                (current_text and current_text[-1] in '.!?')
            )

            if should_break and current_words:
                subtitles.append({
                    'text': current_text,
                    'start': current_words[0]['start'],
                    'end': current_words[-1]['end'],
                })
                current_words = []
                current_text = ''

            current_words.append(w)
            current_text = f"{current_text} {word_text}".strip() if current_text else word_text

        # Don't forget the last group
        if current_words:
            subtitles.append({
                'text': current_text,
                'start': current_words[0]['start'],
                'end': current_words[-1]['end'],
            })

        return subtitles

    # Convert seconds to ASS timecode format (H:MM:SS.cc)
    def secs_to_ass_time(seconds):
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        secs = int(seconds % 60)
        centis = int((seconds % 1) * 100)
        return f"{hours}:{minutes:02d}:{secs:02d}.{centis:02d}"

    subtitles = group_words(word_timestamps)

    if not subtitles:
        if log:
            log.info("No subtitle groups created from word timestamps")
        return False

    # ASS file header with styling
    # Style: White text, bold, black outline, bottom center
    ass_header = """[Script Info]
Title: YVE Generated Subtitles
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,1,2,40,40,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    # Generate dialogue lines
    dialogue_lines = []
    for sub in subtitles:
        start_tc = secs_to_ass_time(sub['start'])
        end_tc = secs_to_ass_time(sub['end'])
        # Escape special characters in text
        text = sub['text'].replace('\\', '\\\\').replace('{', '\\{').replace('}', '\\}')
        dialogue_lines.append(f"Dialogue: 0,{start_tc},{end_tc},Default,,0,0,0,,{text}")

    ass_content = ass_header + '\n'.join(dialogue_lines) + '\n'

    # Write the file
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(ass_content)

    if log:
        log.info("Generated ASS subtitle file with %d subtitle entries -> %s", len(subtitles), output_path)

    return True


# =============================================================================
# SUPABASE RENDER RECORD HELPER
# =============================================================================

def _update_render_in_supabase(supabase_url, service_role_key, render_id,
                                status=None, video_url=None, error_message=None,
                                log=None):
    """Update the renders table in Supabase directly from the VPS."""
    if not supabase_url or not service_role_key or not render_id:
        if log:
            log.warning("Cannot update render in Supabase: missing url/key/render_id")
        return

    payload = {}
    if status:
        payload['status'] = status
    if video_url:
        payload['video_url'] = video_url
    if error_message:
        payload['error_message'] = error_message

    if not payload:
        return

    try:
        url = f"{supabase_url}/rest/v1/renders?id=eq.{render_id}"
        resp = requests.patch(
            url,
            headers={
                'apikey': service_role_key,
                'Authorization': f'Bearer {service_role_key}',
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal',
            },
            json=payload,
            timeout=30,
        )
        if resp.status_code in (200, 204):
            if log:
                log.info("Updated render %s in Supabase: %s", render_id, payload)
        else:
            if log:
                log.error("Failed to update render %s in Supabase: %d %s",
                          render_id, resp.status_code, (resp.text or '')[:300])
    except Exception as e:
        if log:
            log.error("Exception updating render in Supabase: %s", e)


# =============================================================================
# LOVABLE RENDER ENDPOINTS (ADD-ON)
# =============================================================================

@app.route('/api/lovable-render', methods=['POST', 'OPTIONS'])
def lovable_render():
    """Start a render job (Lovable Cloud -> your VPS)."""
    global lovable_render_jobs

    # CORS preflight
    if request.method == 'OPTIONS':
        resp = jsonify({'status': 'ok'})
        resp.headers['Access-Control-Allow-Origin'] = '*'
        resp.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
        resp.headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type'
        return resp

    if not verify_lovable_api_key():
        return jsonify({'success': False, 'error': 'Unauthorized'}), 401

    data = request.get_json(silent=True) or {}
    project_id = data.get('project_id')
    render_id = data.get('render_id')
    scenes = data.get('scenes') or []
    audio_url = data.get('audio_url')
    word_timestamps = data.get('word_timestamps') or []
    supabase_url = data.get('supabase_url')
    supabase_key = data.get('supabase_key')

    if not project_id or not render_id or not audio_url or not isinstance(scenes, list) or len(scenes) == 0:
        return jsonify({'success': False, 'error': 'Missing required fields'}), 400

    job_id = str(uuid.uuid4())
    lovable_render_jobs[job_id] = {
        'status': 'queued',
        'progress': 0,
        'message': 'Queued for rendering',
        'video_url': None,
        'error': None,
    }

    def do_render():
        render_dir = None
        log = logging.getLogger(f'yve-render.{job_id[:8]}')
        log.info("=== RENDER THREAD STARTED === job=%s project=%s render=%s", job_id, project_id, render_id)
        log.info("audio_url=%s  scenes=%d", audio_url, len(scenes))
        # Resolve Supabase credentials early so exception handlers can use them
        _sb_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY') or supabase_key
        try:
            lovable_render_jobs[job_id]['status'] = 'rendering'
            lovable_render_jobs[job_id]['message'] = 'Preparing...'

            render_dir = LOVABLE_TEMP_DIR / f"lovable_{job_id}"
            render_dir.mkdir(parents=True, exist_ok=True)
            log.info("Render dir: %s", render_dir)

            # Download audio
            lovable_render_jobs[job_id]['message'] = 'Downloading audio...'
            log.info("Downloading audio from %s", audio_url)
            audio_path = render_dir / 'audio.mp3'
            audio_resp = requests.get(audio_url, timeout=300)
            audio_resp.raise_for_status()
            audio_path.write_bytes(audio_resp.content)
            log.info("Audio downloaded: %d bytes", len(audio_resp.content))

            # Download images and videos
            lovable_render_jobs[job_id]['message'] = 'Downloading media...'
            scene_files = []
            for i, scene in enumerate(scenes):
                video_url = scene.get('video_url')
                img_url = scene.get('image_url')
                scene_duration = float(scene.get('duration', 10) or 10)

                if video_url:
                    # Download video file
                    vid_path = render_dir / f"scene_{i:03d}_video.mp4"
                    log.info("Downloading scene %d video: %s", i, video_url[:120])
                    r = requests.get(video_url, timeout=300)
                    r.raise_for_status()
                    vid_path.write_bytes(r.content)
                    log.info("Scene %d video: %d bytes -> %s", i, len(r.content), vid_path.name)

                    scene_files.append({
                        'path': str(vid_path),
                        'duration': scene_duration,
                        'is_video': True,
                    })
                elif img_url:
                    # Download image file
                    img_path = render_dir / f"scene_{i:03d}.png"
                    log.info("Downloading scene %d image: %s", i, img_url[:120])
                    r = requests.get(img_url, timeout=120)
                    r.raise_for_status()
                    img_path.write_bytes(r.content)
                    log.info("Scene %d image: %d bytes -> %s", i, len(r.content), img_path.name)

                    scene_files.append({
                        'path': str(img_path),
                        'duration': scene_duration,
                        'is_video': False,
                    })
                else:
                    log.warning("Scene %d has no image_url or video_url, skipping", i)
                    continue

                lovable_render_jobs[job_id]['progress'] = int(((i + 1) / max(len(scenes), 1)) * 20)

            if not scene_files:
                raise Exception('No valid scenes with image_url or video_url')

            log.info("All assets downloaded. %d scene files ready.", len(scene_files))

            # Render segments
            lovable_render_jobs[job_id]['message'] = 'Rendering video segments...'
            segment_files = []
            for i, sf in enumerate(scene_files):
                duration = max(0.5, float(sf['duration']))
                segment_path = render_dir / f"segment_{i:03d}.mp4"

                if sf.get('is_video'):
                    # Video scene: trim to duration, scale to 1920x1080
                    cmd = [
                        'ffmpeg', '-y',
                        '-i', sf['path'],
                        '-t', str(duration),
                        '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
                        '-r', '25',
                        '-c:v', 'libx264',
                        '-pix_fmt', 'yuv420p',
                        '-preset', 'fast',
                        '-an',
                        str(segment_path)
                    ]
                else:
                    # Image scene: static image -> video with loop
                    cmd = [
                        'ffmpeg', '-y',
                        '-loop', '1',
                        '-i', sf['path'],
                        '-t', str(duration),
                        '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
                        '-r', '25',
                        '-c:v', 'libx264',
                        '-pix_fmt', 'yuv420p',
                        '-preset', 'fast',
                        '-an',
                        str(segment_path)
                    ]

                media_type = 'video' if sf.get('is_video') else 'image'
                log.info("FFmpeg segment %d/%d (%s) cmd: %s", i + 1, len(scene_files), media_type, ' '.join(cmd))
                proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
                try:
                    stdout, stderr = proc.communicate(timeout=300)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.communicate()  # drain pipes after kill
                    log.error("FFmpeg segment %d TIMED OUT after 300s, killed", i)
                    raise Exception(f"FFmpeg segment {i} timed out after 300s")

                if proc.returncode != 0:
                    stderr_text = stderr.decode('utf-8', errors='replace') if stderr else ''
                    log.error("FFmpeg segment %d FAILED (rc=%d)\nSTDERR:\n%s", i, proc.returncode, stderr_text[-3000:])
                    raise Exception(f"FFmpeg segment {i} failed (rc={proc.returncode}): {stderr_text[-2000:]}")

                stderr_text = stderr.decode('utf-8', errors='replace') if stderr else ''
                log.info("FFmpeg segment %d/%d OK -> %s (stderr=%d bytes)", i + 1, len(scene_files), segment_path.name, len(stderr_text))

                segment_files.append(str(segment_path))
                lovable_render_jobs[job_id]['progress'] = 20 + int(((i + 1) / len(scene_files)) * 50)
                lovable_render_jobs[job_id]['message'] = f"Rendered segment {i+1}/{len(scene_files)}"

            # Concatenate with crossfade transitions
            log.info("Concatenating %d segments with crossfade transitions...", len(segment_files))
            lovable_render_jobs[job_id]['message'] = 'Adding transitions...'

            silent_video = render_dir / 'silent.mp4'
            fade_duration = 0.5  # Crossfade duration in seconds

            if len(segment_files) == 1:
                # Single segment - just copy it
                shutil.copy2(segment_files[0], silent_video)
                log.info("Single segment, copied directly -> %s", silent_video.name)
            else:
                # Multiple segments - use xfade filter for crossfades
                # Build input arguments
                inputs = []
                for seg in segment_files:
                    inputs.extend(['-i', seg])

                # Build xfade filter chain
                # Each xfade needs: offset = cumulative_duration - fade_duration
                filter_parts = []
                cumulative_duration = 0

                for i in range(len(scene_files) - 1):
                    seg_duration = max(0.5, float(scene_files[i]['duration']))
                    cumulative_duration += seg_duration

                    # Offset is when the fade starts (subtract fade_duration)
                    offset = cumulative_duration - fade_duration

                    if i == 0:
                        # First transition: [0:v][1:v]xfade...
                        filter_parts.append(
                            f"[0:v][1:v]xfade=transition=fade:duration={fade_duration}:offset={offset:.2f}[v{i+1}]"
                        )
                    else:
                        # Subsequent transitions: [vN][N+1:v]xfade...
                        filter_parts.append(
                            f"[v{i}][{i+1}:v]xfade=transition=fade:duration={fade_duration}:offset={offset:.2f}[v{i+1}]"
                        )

                filter_complex = ';'.join(filter_parts)
                final_label = f"[v{len(scene_files)-1}]"

                xfade_cmd = [
                    'ffmpeg', '-y',
                    *inputs,
                    '-filter_complex', filter_complex,
                    '-map', final_label,
                    '-c:v', 'libx264',
                    '-pix_fmt', 'yuv420p',
                    '-preset', 'fast',
                    '-an',
                    str(silent_video)
                ]

                log.info("FFmpeg xfade cmd: %s", ' '.join(xfade_cmd[:20]) + '...')
                proc = subprocess.Popen(xfade_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
                try:
                    stdout, stderr = proc.communicate(timeout=900)  # Longer timeout for complex filter
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.communicate()
                    log.error("FFmpeg xfade TIMED OUT after 900s, killed")
                    raise Exception("FFmpeg xfade timed out after 900s")

                if proc.returncode != 0:
                    stderr_text = stderr.decode('utf-8', errors='replace') if stderr else ''
                    log.error("FFmpeg xfade FAILED (rc=%d)\nSTDERR:\n%s", proc.returncode, stderr_text[-3000:])

                    # Fallback to simple concat without transitions
                    log.warning("Falling back to simple concat without transitions...")
                    concat_list = render_dir / 'concat.txt'
                    with open(concat_list, 'w', encoding='utf-8') as f:
                        for seg in segment_files:
                            f.write(f"file '{seg}'\n")

                    concat_cmd = ['ffmpeg','-y','-f','concat','-safe','0','-i', str(concat_list), '-c','copy', str(silent_video)]
                    proc = subprocess.Popen(concat_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
                    stdout, stderr = proc.communicate(timeout=600)
                    if proc.returncode != 0:
                        stderr_text = stderr.decode('utf-8', errors='replace') if stderr else ''
                        raise Exception(f"FFmpeg concat fallback failed: {stderr_text[-2000:]}")
                    log.info("Fallback concat OK -> %s", silent_video.name)
                else:
                    log.info("Crossfade OK -> %s", silent_video.name)

            lovable_render_jobs[job_id]['progress'] = 75

            # Add audio
            log.info("Merging audio...")
            lovable_render_jobs[job_id]['message'] = 'Adding audio...'
            final_video = render_dir / f"{project_id}_{render_id}.mp4"
            merge_cmd = ['ffmpeg','-y','-i', str(silent_video), '-i', str(audio_path), '-c:v','copy','-c:a','aac','-b:a','192k','-shortest', str(final_video)]
            log.info("FFmpeg merge cmd: %s", ' '.join(merge_cmd))
            proc = subprocess.Popen(merge_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
            try:
                stdout, stderr = proc.communicate(timeout=600)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()
                log.error("FFmpeg merge TIMED OUT after 600s, killed")
                raise Exception("FFmpeg audio merge timed out after 600s")
            if proc.returncode != 0:
                stderr_text = stderr.decode('utf-8', errors='replace') if stderr else ''
                log.error("FFmpeg merge FAILED (rc=%d)\nSTDERR:\n%s", proc.returncode, stderr_text[-3000:])
                raise Exception(f"FFmpeg audio merge failed (rc={proc.returncode}): {stderr_text[-2000:]}")

            log.info("Audio merged: %s", final_video.name)

            lovable_render_jobs[job_id]['progress'] = 82

            # Burn subtitles if word timestamps are available
            if word_timestamps and len(word_timestamps) > 0:
                log.info("Burning subtitles (%d word timestamps)...", len(word_timestamps))
                lovable_render_jobs[job_id]['message'] = 'Adding subtitles...'

                ass_path = render_dir / 'subtitles.ass'
                if _generate_ass_subtitles(word_timestamps, str(ass_path), log=log):
                    # Burn subtitles into video
                    video_with_subs = render_dir / f"{project_id}_{render_id}_subs.mp4"
                    # Note: ass filter requires escaping colons and backslashes in path on some systems
                    ass_path_escaped = str(ass_path).replace('\\', '/').replace(':', '\\:')
                    subs_cmd = [
                        'ffmpeg', '-y',
                        '-i', str(final_video),
                        '-vf', f"ass={ass_path_escaped}",
                        '-c:a', 'copy',
                        '-c:v', 'libx264',
                        '-preset', 'fast',
                        '-crf', '23',
                        str(video_with_subs)
                    ]
                    log.info("FFmpeg subtitle burn cmd: %s", ' '.join(subs_cmd))
                    proc = subprocess.Popen(subs_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
                    try:
                        stdout, stderr = proc.communicate(timeout=600)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.communicate()
                        log.error("FFmpeg subtitle burn TIMED OUT after 600s, killed")
                        # Don't fail the render, just skip subtitles
                        log.warning("Continuing without subtitles")
                    else:
                        if proc.returncode != 0:
                            stderr_text = stderr.decode('utf-8', errors='replace') if stderr else ''
                            log.error("FFmpeg subtitle burn FAILED (rc=%d)\nSTDERR:\n%s", proc.returncode, stderr_text[-2000:])
                            log.warning("Continuing without subtitles")
                        else:
                            # Replace final_video with the subtitled version
                            final_video = video_with_subs
                            log.info("Subtitles burned successfully -> %s", video_with_subs.name)
            else:
                log.info("No word timestamps, skipping subtitle generation")

            lovable_render_jobs[job_id]['progress'] = 90

            final_size = final_video.stat().st_size
            log.info("Final video: %s (%.1f MB)", final_video.name, final_size / (1024 * 1024))

            # Always save a local backup first
            backup_dir = OUTPUT_DIR / str(project_id)
            backup_dir.mkdir(parents=True, exist_ok=True)
            backup_path = backup_dir / f"{render_id}.mp4"
            shutil.copy2(final_video, backup_path)
            log.info("Local backup saved -> %s", backup_path)
            lovable_render_jobs[job_id]['local_path'] = str(backup_path)

            # Upload to Supabase (use service role key from env, not client-provided anon key)
            lovable_render_jobs[job_id]['message'] = 'Uploading...'
            service_role_key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY') or supabase_key
            if supabase_url and service_role_key:
                if os.environ.get('SUPABASE_SERVICE_ROLE_KEY'):
                    log.info("Using SUPABASE_SERVICE_ROLE_KEY from environment")
                else:
                    log.warning("SUPABASE_SERVICE_ROLE_KEY not set, falling back to client-provided key (may lack permissions)")

                storage_path = f"{project_id}/{render_id}.mp4"
                upload_url = f"{supabase_url}/storage/v1/object/renders/{storage_path}"
                log.info("Uploading to Supabase: %s (%.1f MB)", storage_path, final_size / (1024 * 1024))

                with open(final_video, 'rb') as f:
                    video_data = f.read()

                up = requests.post(
                    upload_url,
                    headers={
                        'Authorization': f'Bearer {service_role_key}',
                        'Content-Type': 'video/mp4',
                        'x-upsert': 'true',
                    },
                    data=video_data,
                    timeout=1200,
                )

                if up.status_code not in (200, 201):
                    log.error("Supabase upload failed: %d %s (video preserved at %s)", up.status_code, (up.text or '')[:500], backup_path)
                    # Use VPS video endpoint so the frontend can reach the video
                    lovable_render_jobs[job_id]['video_url'] = f"http://31.97.147.132:5001/api/video/{project_id}/{render_id}"
                    lovable_render_jobs[job_id]['upload_error'] = f"{up.status_code}: {(up.text or '')[:300]}"
                    # Don't raise — video is saved locally, mark as completed with warning
                else:
                    public_url = f"{supabase_url}/storage/v1/object/public/renders/{storage_path}"
                    lovable_render_jobs[job_id]['video_url'] = public_url
                    log.info("Upload OK -> %s", public_url)
            else:
                # No Supabase credentials — use VPS video endpoint for local serving
                lovable_render_jobs[job_id]['video_url'] = f"http://31.97.147.132:5001/api/video/{project_id}/{render_id}"
                log.info("No Supabase credentials, using VPS video endpoint")

            lovable_render_jobs[job_id]['status'] = 'completed'
            lovable_render_jobs[job_id]['progress'] = 100
            lovable_render_jobs[job_id]['message'] = 'Render complete'
            log.info("=== RENDER COMPLETE === job=%s", job_id)

            # --- Update Supabase renders table directly ---
            _update_render_in_supabase(
                supabase_url, _sb_key, render_id,
                status='completed',
                video_url=lovable_render_jobs[job_id].get('video_url'),
                log=log
            )

        except subprocess.TimeoutExpired as e:
            msg = f"FFmpeg timed out after {e.timeout}s"
            log.error("=== RENDER TIMEOUT === job=%s: %s", job_id, msg)
            lovable_render_jobs[job_id]['status'] = 'failed'
            lovable_render_jobs[job_id]['error'] = msg
            lovable_render_jobs[job_id]['message'] = msg
            _update_render_in_supabase(
                supabase_url, _sb_key, render_id,
                status='failed', error_message=msg, log=log
            )
        except Exception as e:
            tb = traceback.format_exc()
            log.error("=== RENDER FAILED === job=%s\n%s", job_id, tb)
            lovable_render_jobs[job_id]['status'] = 'failed'
            lovable_render_jobs[job_id]['error'] = str(e)
            lovable_render_jobs[job_id]['message'] = f"Error: {e}"
            _update_render_in_supabase(
                supabase_url, _sb_key, render_id,
                status='failed', error_message=str(e), log=log
            )
        finally:
            # Only clean up temp dir if render completed successfully
            if lovable_render_jobs[job_id].get('status') == 'completed' and render_dir:
                shutil.rmtree(render_dir, ignore_errors=True)
                log.info("Cleaned up render dir for job=%s", job_id)
            elif render_dir:
                log.info("Keeping render dir for failed job=%s: %s", job_id, render_dir)

    t = threading.Thread(target=do_render, daemon=True)
    t.start()
    logger.info("Render job dispatched: job=%s project=%s", job_id, project_id)

    resp = jsonify({'success': True, 'job_id': job_id})
    resp.headers['Access-Control-Allow-Origin'] = '*'
    return resp


@app.route('/api/lovable-render/<job_id>/status', methods=['GET', 'OPTIONS'])
def lovable_render_status(job_id):
    """Poll render job status."""

    # CORS preflight
    if request.method == 'OPTIONS':
        resp = jsonify({'status': 'ok'})
        resp.headers['Access-Control-Allow-Origin'] = '*'
        resp.headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
        resp.headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type'
        return resp

    if not verify_lovable_api_key():
        return jsonify({'success': False, 'error': 'Unauthorized'}), 401

    job = lovable_render_jobs.get(job_id)
    if not job:
        return jsonify({'success': False, 'error': 'Job not found'}), 404

    resp = jsonify({'success': True, **job})
    resp.headers['Access-Control-Allow-Origin'] = '*'
    return resp


if __name__ == '__main__':
    print("=" * 80)
    print("🎬 YOUTUBE VIDEO ENGINE - Server Starting")
    print("=" * 80)
    print(f"Dashboard: http://0.0.0.0:5001")
    print(f"Upload: {BASE_DIR / 'uploads'}")
    print(f"Output: {BASE_DIR / 'output'}")
    print("=" * 80)
    
    try:
        from flask_cors import CORS
        CORS(app)
    except:
        print("Installing flask-cors...")
        subprocess.run(['pip', 'install', 'flask-cors', '--break-system-packages'])
    
    app.run(host='0.0.0.0', port=5001, debug=False)

# ============================================
# NEW ENDPOINTS - Video Upload & Whisper
# ============================================

