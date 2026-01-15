"""
Lovable VPS Render Endpoint
===========================
This file handles video rendering requests from Lovable Cloud.
Upload this file to your VPS at /root/story-automationvps/

Setup:
1. SFTP this file to /root/story-automationvps/
2. Add to backend_server.py (before if __name__):
   from lovable_render_endpoint import register_lovable_endpoints
   register_lovable_endpoints(app)
3. Restart: ./restart_yve.sh
"""

import os
import uuid
import threading
import subprocess
import requests
import tempfile
import shutil
from flask import jsonify, request

# Your API key for authentication
VPS_API_KEY = "T6ELEzKycQ5zKBiTcVhccaNi7Ldynl9PcRlwmyGFac257a17"

# Store render job status
render_jobs = {}


def verify_api_key():
    """Verify the API key from Authorization header"""
    auth_header = request.headers.get('Authorization', '')
    if not auth_header.startswith('Bearer '):
        return False
    token = auth_header[7:]  # Remove 'Bearer ' prefix
    return token == VPS_API_KEY


def download_file(url, local_path):
    """Download a file from URL to local path"""
    response = requests.get(url, stream=True, timeout=300)
    response.raise_for_status()
    with open(local_path, 'wb') as f:
        for chunk in response.iter_content(chunk_size=8192):
            f.write(chunk)
    return local_path


def render_video_with_ffmpeg(job_id, scenes, audio_url, supabase_url, supabase_key, project_id, render_id):
    """
    Render video using FFmpeg with Ken Burns effect
    """
    try:
        render_jobs[job_id]['status'] = 'downloading'
        render_jobs[job_id]['message'] = 'Downloading assets...'
        
        # Create temp directory for this job
        work_dir = tempfile.mkdtemp(prefix=f'lovable_render_{job_id}_')
        
        # Download audio
        audio_path = os.path.join(work_dir, 'audio.mp3')
        download_file(audio_url, audio_path)
        
        # Download all images and prepare segments
        segments = []
        for i, scene in enumerate(scenes):
            render_jobs[job_id]['progress'] = int((i / len(scenes)) * 30)
            render_jobs[job_id]['message'] = f'Downloading scene {i + 1}/{len(scenes)}...'
            
            # Get image URL (support both single image and multiple images)
            image_url = scene.get('image_url')
            if not image_url and scene.get('image_urls'):
                image_url = scene['image_urls'][0]
            
            if not image_url:
                continue
            
            # Download image
            img_ext = '.jpg'
            if '.png' in image_url.lower():
                img_ext = '.png'
            img_path = os.path.join(work_dir, f'scene_{i:03d}{img_ext}')
            download_file(image_url, img_path)
            
            # Calculate duration
            duration = scene.get('end_time', 0) - scene.get('start_time', 0)
            if duration <= 0:
                duration = 5  # Default 5 seconds
            
            segments.append({
                'image': img_path,
                'duration': duration,
                'index': i
            })
        
        if not segments:
            raise Exception("No valid scenes to render")
        
        render_jobs[job_id]['status'] = 'rendering'
        render_jobs[job_id]['message'] = 'Rendering video segments...'
        render_jobs[job_id]['progress'] = 30
        
        # Render each segment with Ken Burns effect
        segment_videos = []
        for i, segment in enumerate(segments):
            render_jobs[job_id]['progress'] = 30 + int((i / len(segments)) * 40)
            render_jobs[job_id]['message'] = f'Rendering segment {i + 1}/{len(segments)}...'
            
            segment_video = os.path.join(work_dir, f'segment_{i:03d}.mp4')
            
            # Alternate between zoom in and zoom out for Ken Burns effect
            if i % 2 == 0:
                # Zoom in (1.0 -> 1.15)
                zoom_filter = "zoompan=z='min(zoom+0.0003,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={fps}*{dur}:s=1920x1080:fps={fps}"
            else:
                # Zoom out (1.15 -> 1.0)
                zoom_filter = "zoompan=z='if(lte(zoom,1.0),1.15,max(1.001,zoom-0.0003))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={fps}*{dur}:s=1920x1080:fps={fps}"
            
            fps = 30
            dur = segment['duration']
            zoom_filter = zoom_filter.format(fps=fps, dur=dur)
            
            cmd = [
                'ffmpeg', '-y',
                '-loop', '1',
                '-i', segment['image'],
                '-vf', zoom_filter,
                '-t', str(dur),
                '-c:v', 'libx264',
                '-preset', 'medium',
                '-crf', '23',
                '-pix_fmt', 'yuv420p',
                segment_video
            ]
            
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            if result.returncode != 0:
                print(f"FFmpeg segment error: {result.stderr}")
                raise Exception(f"FFmpeg segment render failed: {result.stderr[:500]}")
            
            segment_videos.append(segment_video)
        
        render_jobs[job_id]['progress'] = 70
        render_jobs[job_id]['message'] = 'Concatenating segments...'
        
        # Create concat file
        concat_file = os.path.join(work_dir, 'concat.txt')
        with open(concat_file, 'w') as f:
            for video in segment_videos:
                f.write(f"file '{video}'\n")
        
        # Concatenate all segments
        concat_video = os.path.join(work_dir, 'concat.mp4')
        cmd = [
            'ffmpeg', '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', concat_file,
            '-c', 'copy',
            concat_video
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if result.returncode != 0:
            raise Exception(f"FFmpeg concat failed: {result.stderr[:500]}")
        
        render_jobs[job_id]['progress'] = 80
        render_jobs[job_id]['message'] = 'Adding audio...'
        
        # Add audio to video
        final_video = os.path.join(work_dir, 'final.mp4')
        cmd = [
            'ffmpeg', '-y',
            '-i', concat_video,
            '-i', audio_path,
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-shortest',
            final_video
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if result.returncode != 0:
            raise Exception(f"FFmpeg audio merge failed: {result.stderr[:500]}")
        
        render_jobs[job_id]['progress'] = 90
        render_jobs[job_id]['message'] = 'Uploading to storage...'
        
        # Upload to Supabase storage
        with open(final_video, 'rb') as f:
            video_data = f.read()
        
        storage_path = f"{project_id}/{render_id}.mp4"
        upload_url = f"{supabase_url}/storage/v1/object/renders/{storage_path}"
        
        headers = {
            'Authorization': f'Bearer {supabase_key}',
            'Content-Type': 'video/mp4',
            'x-upsert': 'true'
        }
        
        response = requests.post(upload_url, data=video_data, headers=headers, timeout=600)
        
        if response.status_code not in [200, 201]:
            raise Exception(f"Upload failed: {response.status_code} - {response.text[:500]}")
        
        # Get public URL
        video_url = f"{supabase_url}/storage/v1/object/public/renders/{storage_path}"
        
        # Cleanup
        shutil.rmtree(work_dir, ignore_errors=True)
        
        render_jobs[job_id]['status'] = 'completed'
        render_jobs[job_id]['progress'] = 100
        render_jobs[job_id]['message'] = 'Render complete!'
        render_jobs[job_id]['video_url'] = video_url
        
    except Exception as e:
        render_jobs[job_id]['status'] = 'failed'
        render_jobs[job_id]['error'] = str(e)
        render_jobs[job_id]['message'] = f'Error: {str(e)}'
        print(f"Render job {job_id} failed: {e}")
        
        # Cleanup on error
        if 'work_dir' in locals():
            shutil.rmtree(work_dir, ignore_errors=True)


def register_lovable_endpoints(app):
    """Register the Lovable render endpoints with the Flask app"""
    
    @app.route('/api/lovable-render', methods=['POST', 'OPTIONS'])
    def lovable_render():
        # Handle CORS preflight
        if request.method == 'OPTIONS':
            response = jsonify({'status': 'ok'})
            response.headers['Access-Control-Allow-Origin'] = '*'
            response.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
            response.headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type'
            return response
        
        # Verify API key
        if not verify_api_key():
            return jsonify({'error': 'Unauthorized'}), 401
        
        try:
            data = request.get_json()
            
            # Required fields
            project_id = data.get('project_id')
            render_id = data.get('render_id')
            scenes = data.get('scenes', [])
            audio_url = data.get('audio_url')
            supabase_url = data.get('supabase_url')
            supabase_key = data.get('supabase_key')
            
            if not all([project_id, render_id, scenes, audio_url, supabase_url, supabase_key]):
                return jsonify({'error': 'Missing required fields'}), 400
            
            # Create job
            job_id = str(uuid.uuid4())
            render_jobs[job_id] = {
                'status': 'queued',
                'progress': 0,
                'message': 'Job queued...',
                'video_url': None,
                'error': None
            }
            
            # Start rendering in background
            thread = threading.Thread(
                target=render_video_with_ffmpeg,
                args=(job_id, scenes, audio_url, supabase_url, supabase_key, project_id, render_id)
            )
            thread.daemon = True
            thread.start()
            
            response = jsonify({
                'success': True,
                'job_id': job_id,
                'message': 'Render job started'
            })
            response.headers['Access-Control-Allow-Origin'] = '*'
            return response
            
        except Exception as e:
            return jsonify({'error': str(e)}), 500
    
    @app.route('/api/lovable-render/<job_id>/status', methods=['GET', 'OPTIONS'])
    def lovable_render_status(job_id):
        # Handle CORS preflight
        if request.method == 'OPTIONS':
            response = jsonify({'status': 'ok'})
            response.headers['Access-Control-Allow-Origin'] = '*'
            response.headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
            response.headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type'
            return response
        
        # Verify API key
        if not verify_api_key():
            return jsonify({'error': 'Unauthorized'}), 401
        
        job = render_jobs.get(job_id)
        if not job:
            return jsonify({'error': 'Job not found'}), 404
        
        response = jsonify({
            'status': job['status'],
            'progress': job['progress'],
            'message': job['message'],
            'video_url': job['video_url'],
            'error': job['error']
        })
        response.headers['Access-Control-Allow-Origin'] = '*'
        return response
    
    print("✅ Lovable render endpoints registered: /api/lovable-render")
