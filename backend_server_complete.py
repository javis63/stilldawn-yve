"""
Complete Backend Server for VPS
================================
Replace your /root/story-automationvps/backend_server.py with this file.
Then run: ./restart_yve.sh

This includes:
- All standard Flask setup
- The Lovable render endpoint with API key authentication
- Ken Burns effects on all images
- Automatic upload to Supabase storage
"""

import os
import subprocess
import uuid
import threading
import requests
import shutil
from pathlib import Path
from flask import Flask, request, jsonify
from flask_cors import CORS

# =============================================================================
# CONFIGURATION
# =============================================================================

# Your API key for authentication from Lovable
VPS_API_KEY = "T6ELEzKycQ5zKBiTcVhccaNi7Ldynl9PcRlwmyGFac257a17"

# Directories
BASE_DIR = Path('/root/story-automation')
UPLOAD_DIR = BASE_DIR / 'uploads'
OUTPUT_DIR = BASE_DIR / 'output'
TEMP_DIR = BASE_DIR / 'temp'

# Create directories if they don't exist
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
TEMP_DIR.mkdir(parents=True, exist_ok=True)

# =============================================================================
# FLASK APP SETUP
# =============================================================================

app = Flask(__name__)
CORS(app)

# Store for tracking render jobs
render_jobs = {}


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

def verify_api_key():
    """Verify the API key from Authorization header"""
    auth_header = request.headers.get('Authorization', '')
    if not auth_header.startswith('Bearer '):
        return False
    token = auth_header[7:]  # Remove 'Bearer ' prefix
    return token == VPS_API_KEY


# =============================================================================
# HEALTH CHECK ENDPOINT
# =============================================================================

@app.route('/health', methods=['GET'])
def health_check():
    """Simple health check endpoint"""
    return jsonify({'status': 'healthy', 'message': 'VPS server is running'})


@app.route('/', methods=['GET'])
def root():
    """Root endpoint"""
    return jsonify({
        'status': 'running',
        'service': 'Lovable VPS Render Server',
        'endpoints': [
            '/health',
            '/api/lovable-render',
            '/api/lovable-render/<job_id>/status'
        ]
    })


# =============================================================================
# LOVABLE RENDER ENDPOINT
# =============================================================================

@app.route('/api/lovable-render', methods=['POST', 'OPTIONS'])
def lovable_render():
    """
    Endpoint for Lovable Cloud to request video renders.
    Accepts JSON with scenes, audio URL, and callback info.
    Renders locally with FFmpeg and uploads result.
    """
    global render_jobs
    
    # Handle CORS preflight
    if request.method == 'OPTIONS':
        response = jsonify({'status': 'ok'})
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type'
        return response
    
    # Verify API key
    if not verify_api_key():
        return jsonify({'success': False, 'error': 'Unauthorized'}), 401
    
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': 'No JSON data provided'}), 400
        
        # Required fields
        project_id = data.get('project_id')
        render_id = data.get('render_id')
        scenes = data.get('scenes', [])
        audio_url = data.get('audio_url')
        supabase_url = data.get('supabase_url')
        supabase_key = data.get('supabase_key')
        
        if not all([project_id, render_id, scenes, audio_url]):
            return jsonify({'success': False, 'error': 'Missing required fields'}), 400
        
        job_id = str(uuid.uuid4())
        render_jobs[job_id] = {
            'status': 'queued',
            'progress': 0,
            'message': 'Queued for rendering',
            'video_url': None,
            'error': None
        }
        
        # Start render in background
        def do_render():
            try:
                render_jobs[job_id]['status'] = 'rendering'
                render_jobs[job_id]['message'] = 'Downloading assets...'
                
                # Create temp directory for this render
                render_dir = TEMP_DIR / f'lovable_{job_id}'
                render_dir.mkdir(parents=True, exist_ok=True)
                
                # Download audio
                render_jobs[job_id]['message'] = 'Downloading audio...'
                audio_path = render_dir / 'audio.mp3'
                audio_resp = requests.get(audio_url, timeout=300)
                audio_path.write_bytes(audio_resp.content)
                
                # Download images and prepare scene list
                render_jobs[job_id]['message'] = 'Downloading images...'
                scene_files = []
                for i, scene in enumerate(scenes):
                    img_url = scene.get('image_url')
                    if not img_url:
                        continue
                    
                    img_path = render_dir / f'scene_{i:03d}.png'
                    img_resp = requests.get(img_url, timeout=60)
                    img_path.write_bytes(img_resp.content)
                    
                    scene_files.append({
                        'path': str(img_path),
                        'duration': scene.get('duration', 10),
                        'narration': scene.get('narration', ''),
                        'scene_number': scene.get('scene_number', i + 1)
                    })
                    
                    render_jobs[job_id]['progress'] = int((i + 1) / len(scenes) * 20)
                
                if not scene_files:
                    raise Exception("No valid scenes with images to render")
                
                # Generate video segments with Ken Burns
                render_jobs[job_id]['message'] = 'Rendering video segments...'
                segment_files = []
                
                for i, sf in enumerate(scene_files):
                    segment_path = render_dir / f'segment_{i:03d}.mp4'
                    duration = sf['duration']
                    
                    # Ken Burns effect: alternating zoom in/out
                    if i % 2 == 0:
                        # Zoom in (1.0 -> 1.15)
                        zoompan = f"zoompan=z='1+0.001*in':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={int(duration*30)}:s=1920x1080:fps=30"
                    else:
                        # Zoom out (1.15 -> 1.0)
                        zoompan = f"zoompan=z='1.15-0.001*in':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={int(duration*30)}:s=1920x1080:fps=30"
                    
                    cmd = [
                        'ffmpeg', '-y',
                        '-loop', '1',
                        '-i', sf['path'],
                        '-t', str(duration),
                        '-vf', f"scale=1920x1080:force_original_aspect_ratio=increase,crop=1920x1080,{zoompan}",
                        '-c:v', 'libx264',
                        '-pix_fmt', 'yuv420p',
                        '-preset', 'fast',
                        '-an',
                        str(segment_path)
                    ]
                    
                    result = subprocess.run(cmd, capture_output=True, text=True)
                    if result.returncode != 0:
                        print(f"FFmpeg error: {result.stderr}")
                        raise Exception(f"FFmpeg segment render failed: {result.stderr[:200]}")
                    
                    segment_files.append(str(segment_path))
                    
                    render_jobs[job_id]['progress'] = 20 + int((i + 1) / len(scene_files) * 50)
                    render_jobs[job_id]['message'] = f'Rendering segment {i+1}/{len(scene_files)}...'
                
                # Concatenate segments
                render_jobs[job_id]['message'] = 'Concatenating segments...'
                concat_list = render_dir / 'concat.txt'
                with open(concat_list, 'w') as f:
                    for seg in segment_files:
                        f.write(f"file '{seg}'\n")
                
                silent_video = render_dir / 'silent.mp4'
                cmd = [
                    'ffmpeg', '-y',
                    '-f', 'concat',
                    '-safe', '0',
                    '-i', str(concat_list),
                    '-c:v', 'libx264',
                    '-pix_fmt', 'yuv420p',
                    '-preset', 'fast',
                    str(silent_video)
                ]
                result = subprocess.run(cmd, capture_output=True, text=True)
                if result.returncode != 0:
                    raise Exception(f"FFmpeg concat failed: {result.stderr[:200]}")
                
                render_jobs[job_id]['progress'] = 75
                
                # Add audio
                render_jobs[job_id]['message'] = 'Adding audio track...'
                final_video = render_dir / f'{project_id}_final.mp4'
                cmd = [
                    'ffmpeg', '-y',
                    '-i', str(silent_video),
                    '-i', str(audio_path),
                    '-c:v', 'copy',
                    '-c:a', 'aac',
                    '-b:a', '192k',
                    '-shortest',
                    str(final_video)
                ]
                result = subprocess.run(cmd, capture_output=True, text=True)
                if result.returncode != 0:
                    raise Exception(f"FFmpeg audio merge failed: {result.stderr[:200]}")
                
                render_jobs[job_id]['progress'] = 90
                
                # Upload to Supabase storage
                render_jobs[job_id]['message'] = 'Uploading to storage...'
                
                if supabase_url and supabase_key:
                    with open(final_video, 'rb') as f:
                        video_data = f.read()
                    
                    storage_path = f'{project_id}/{render_id}.mp4'
                    upload_url = f"{supabase_url}/storage/v1/object/renders/{storage_path}"
                    
                    resp = requests.post(
                        upload_url,
                        headers={
                            'Authorization': f'Bearer {supabase_key}',
                            'Content-Type': 'video/mp4',
                            'x-upsert': 'true'
                        },
                        data=video_data,
                        timeout=600
                    )
                    
                    if resp.status_code in (200, 201):
                        public_url = f"{supabase_url}/storage/v1/object/public/renders/{storage_path}"
                        render_jobs[job_id]['video_url'] = public_url
                    else:
                        raise Exception(f"Upload failed: {resp.status_code} - {resp.text[:200]}")
                else:
                    # Copy to output folder if no Supabase credentials
                    output_path = OUTPUT_DIR / f'{project_id}_final.mp4'
                    shutil.copy(final_video, output_path)
                    render_jobs[job_id]['video_url'] = f'/output/{project_id}_final.mp4'
                
                render_jobs[job_id]['status'] = 'completed'
                render_jobs[job_id]['progress'] = 100
                render_jobs[job_id]['message'] = 'Render complete!'
                
                # Cleanup temp files
                shutil.rmtree(render_dir, ignore_errors=True)
                
            except Exception as e:
                import traceback
                render_jobs[job_id]['status'] = 'failed'
                render_jobs[job_id]['error'] = str(e)
                render_jobs[job_id]['message'] = f'Error: {e}'
                print(f"Render error: {traceback.format_exc()}")
                
                # Cleanup on error
                if 'render_dir' in locals():
                    shutil.rmtree(render_dir, ignore_errors=True)
        
        # Start rendering in background thread
        thread = threading.Thread(target=do_render)
        thread.daemon = True
        thread.start()
        
        response = jsonify({
            'success': True,
            'job_id': job_id,
            'message': 'Render started'
        })
        response.headers['Access-Control-Allow-Origin'] = '*'
        return response
        
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/lovable-render/<job_id>/status', methods=['GET', 'OPTIONS'])
def lovable_render_status(job_id):
    """Check status of a render job"""
    
    # Handle CORS preflight
    if request.method == 'OPTIONS':
        response = jsonify({'status': 'ok'})
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type'
        return response
    
    # Verify API key
    if not verify_api_key():
        return jsonify({'success': False, 'error': 'Unauthorized'}), 401
    
    if job_id not in render_jobs:
        return jsonify({'success': False, 'error': 'Job not found'}), 404
    
    job = render_jobs[job_id]
    response = jsonify({
        'success': True,
        'status': job['status'],
        'progress': job['progress'],
        'message': job['message'],
        'video_url': job['video_url'],
        'error': job['error']
    })
    response.headers['Access-Control-Allow-Origin'] = '*'
    return response


# =============================================================================
# RUN SERVER
# =============================================================================

if __name__ == '__main__':
    print("=" * 60)
    print("  Lovable VPS Render Server")
    print("  API Key Authentication: ENABLED")
    print("=" * 60)
    print(f"  Endpoints:")
    print(f"    POST /api/lovable-render")
    print(f"    GET  /api/lovable-render/<job_id>/status")
    print("=" * 60)
    
    app.run(host='0.0.0.0', port=5000, debug=False, threaded=True)
