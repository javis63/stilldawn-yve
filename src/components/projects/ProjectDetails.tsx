import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import {
  Wand2,
  Layers,
  Play,
  Pause,
  Download,
  Upload,
  RefreshCw,
  Film,
  Clock,
  Image,
  CheckCircle,
  AlertCircle,
  Volume2,
  VolumeX,
  FileVideo,
  FileText,
  Images,
  Archive,
} from "lucide-react";
import { Project, Scene } from "@/types/project";
import { supabase } from "@/integrations/supabase/client";
import { formatDistanceToNow } from "date-fns";
import { SceneCard } from "./SceneCard";
import { toast } from "sonner";
import { Progress } from "@/components/ui/progress";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  generateEDL,
  generateSceneCSV,
  downloadFile,
  downloadAllImages,
  getSceneImages,
  generateSRT,
  generateVTT,
  downloadDaVinciBundle,
  WordTimestamp,
} from "@/utils/davinciExport";
import { splitAudioIntoChunks, ChunkingProgress } from "@/utils/audioChunking";

interface ProjectDetailsProps {
  project: Project;
  onRefresh: () => void;
}

export function ProjectDetails({ project, onRefresh }: ProjectDetailsProps) {
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedScenes, setExpandedScenes] = useState<Set<string>>(new Set());
  const [processing, setProcessing] = useState<string | null>(null);
  const [currentProject, setCurrentProject] = useState<Project>(project);
  const [renderProgress, setRenderProgress] = useState(0);
  const [thumbnailSceneId, setThumbnailSceneId] = useState<string | null>(null);
  const [wordTimestamps, setWordTimestamps] = useState<WordTimestamp[]>([]);
  
  // Audio player state
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioProgress, setAudioProgress] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);

  // Keep local project state in sync with prop
  useEffect(() => {
    setCurrentProject(project);
  }, [project]);

  // Fetch thumbnail scene id and word timestamps from project
  useEffect(() => {
    const fetchProjectDetails = async () => {
      const { data } = await supabase
        .from("projects")
        .select("thumbnail_scene_id, word_timestamps")
        .eq("id", project.id)
        .maybeSingle();
      
      if (data?.thumbnail_scene_id) {
        setThumbnailSceneId(data.thumbnail_scene_id);
      }
      
      // Parse word timestamps
      if (data?.word_timestamps) {
        try {
          const timestamps = typeof data.word_timestamps === 'string'
            ? JSON.parse(data.word_timestamps)
            : data.word_timestamps;
          if (Array.isArray(timestamps)) {
            setWordTimestamps(timestamps);
          }
        } catch (e) {
          console.warn('Failed to parse word timestamps:', e);
        }
      }
    };
    fetchProjectDetails();
  }, [project.id]);

  const fetchScenes = async () => {
    try {
      const { data, error } = await supabase
        .from("scenes")
        .select("*")
        .eq("project_id", project.id)
        .order("scene_number", { ascending: true });

      if (error) throw error;
      setScenes(data || []);
    } catch (error) {
      console.error("Error fetching scenes:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchScenes();
  }, [project.id]);

  const toggleScene = (sceneId: string) => {
    setExpandedScenes((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(sceneId)) {
        newSet.delete(sceneId);
      } else {
        newSet.add(sceneId);
      }
      return newSet;
    });
  };

  const expandAll = () => {
    setExpandedScenes(new Set(scenes.map((s) => s.id)));
  };

  const collapseAll = () => {
    setExpandedScenes(new Set());
  };

  // Audio player functions
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const togglePlayPause = () => {
    if (!audioRef.current) return;
    
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const handleTimeUpdate = () => {
    if (!audioRef.current) return;
    setAudioProgress(audioRef.current.currentTime);
  };

  const handleLoadedMetadata = () => {
    if (!audioRef.current) return;
    setAudioDuration(audioRef.current.duration);
  };

  const handleSeek = (value: number[]) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = value[0];
    setAudioProgress(value[0]);
  };

  const handleVolumeChange = (value: number[]) => {
    if (!audioRef.current) return;
    const newVolume = value[0];
    audioRef.current.volume = newVolume;
    setVolume(newVolume);
    setIsMuted(newVolume === 0);
  };

  const toggleMute = () => {
    if (!audioRef.current) return;
    if (isMuted) {
      audioRef.current.volume = volume || 1;
      setIsMuted(false);
    } else {
      audioRef.current.volume = 0;
      setIsMuted(true);
    }
  };

  const handleAudioEnded = () => {
    setIsPlaying(false);
    setAudioProgress(0);
  };

  const handleSetThumbnail = async (sceneId: string | null) => {
    try {
      const { error } = await supabase
        .from("projects")
        .update({ thumbnail_scene_id: sceneId })
        .eq("id", project.id);

      if (error) throw error;
      
      setThumbnailSceneId(sceneId);
      toast.success(sceneId ? "Thumbnail scene selected" : "Thumbnail scene cleared");
    } catch (error: any) {
      toast.error(error.message || "Failed to set thumbnail scene");
    }
  };

  const handleGenerateTimestamps = async () => {
    if (!currentProject.audio_url) {
      toast.error("No audio file uploaded");
      return;
    }

    setProcessing("timestamps");
    toast.info("Generating transcript with Whisper... This may take a while for long audio.");

    try {
      // Prefer chunked transcription when the audio file is large.
      // This avoids edge-function memory limits when someone uploaded a huge WAV.
      let shouldUseChunks = false;
      try {
        const head = await fetch(currentProject.audio_url, { method: "HEAD" });
        const len = head.headers.get("content-length");
        if (len && parseInt(len, 10) > 25 * 1024 * 1024) {
          shouldUseChunks = true;
        }
      } catch {
        // If HEAD fails, fall back to the original flow.
      }

      if (shouldUseChunks) {
        // Discover chunk files from storage: {projectId}/chunk_0.wav, chunk_1.wav, ...
        const { data: files, error: listError } = await supabase.storage
          .from("audio")
          .list(currentProject.id, {
            limit: 1000,
            sortBy: { column: "name", order: "asc" },
          });

        if (listError) throw listError;

        let chunkFiles = (files || [])
          .map((f) => f.name)
          .map((name) => {
            const match = name.match(/^chunk_(\d+)\.wav$/);
            return match ? { name, index: parseInt(match[1], 10) } : null;
          })
          .filter((x): x is { name: string; index: number } => !!x)
          .sort((a, b) => a.index - b.index);

        // Backward-compat: older projects may have only a single huge audio file.
        // In that case, we create chunks client-side once, upload them, then proceed.
        if (chunkFiles.length === 0) {
          toast.info(
            "This project has a large audio file but no chunks yet. Creating chunks in your browser (one-time step)..."
          );

          const res = await fetch(currentProject.audio_url);
          if (!res.ok) {
            throw new Error(`Failed to download audio: ${res.statusText}`);
          }

          const blob = await res.blob();
          const fileForChunking = new File([blob], "audio", {
            type: blob.type || "audio/wav",
          });

          const { chunks: createdChunks, totalDuration } = await splitAudioIntoChunks(
            fileForChunking,
            (p: ChunkingProgress) => {
              // Keep it light: avoid spamming toasts.
              if (p.stage === "chunking" && p.currentChunk && p.totalChunks) {
                setRenderProgress(Math.round((p.currentChunk / p.totalChunks) * 100));
              }
            }
          );

          // Upload chunks
          for (let i = 0; i < createdChunks.length; i++) {
            const chunkPath = `${currentProject.id}/chunk_${i}.wav`;
            const { error: uploadErr } = await supabase.storage
              .from("audio")
              .upload(chunkPath, createdChunks[i].blob, {
                cacheControl: "3600",
                upsert: true,
              });
            if (uploadErr) throw uploadErr;
          }

          // Persist duration (and keep audio_url as-is)
          await supabase
            .from("projects")
            .update({ audio_duration: totalDuration })
            .eq("id", currentProject.id);

          chunkFiles = createdChunks.map((_, i) => ({
            name: `chunk_${i}.wav`,
            index: i,
          }));
        }

        const transcripts: string[] = [];
        let totalDuration = 0;
        
        // PHASE 1 FIX: Accumulate word timestamps with proper time offsets
        const allWordTimestamps: Array<{ word: string; start: number; end: number }> = [];
        let timeOffset = 0;

        for (let i = 0; i < chunkFiles.length; i++) {
          toast.info(`Transcribing chunk ${i + 1}/${chunkFiles.length}...`);

          const { data: urlData } = supabase.storage
            .from("audio")
            .getPublicUrl(`${currentProject.id}/${chunkFiles[i].name}`);

          const { data, error } = await supabase.functions.invoke("transcribe-chunk", {
            body: {
              audioUrl: urlData.publicUrl,
              chunkIndex: i,
              totalChunks: chunkFiles.length,
            },
          });

          if (error) throw error;
          if (!data?.success) throw new Error(data?.error || `Transcription failed for chunk ${i + 1}`);

          transcripts.push(data.text);
          const chunkDuration = Number(data.duration || 0);
          totalDuration += chunkDuration;
          
          // Accumulate word timestamps with offset applied
          if (data.words && Array.isArray(data.words)) {
            for (const word of data.words) {
              allWordTimestamps.push({
                word: word.word,
                start: word.start + timeOffset,
                end: word.end + timeOffset,
              });
            }
          }
          
          // Update offset for next chunk
          timeOffset += chunkDuration;
        }

        const fullTranscript = transcripts.join(" ");
        
        console.log(`Chunked transcription complete: ${allWordTimestamps.length} words, ${totalDuration}s total`);

        // Save transcript AND word_timestamps to database
        const { error: updateError } = await supabase
          .from("projects")
          .update({
            transcript: fullTranscript,
            audio_duration: totalDuration || currentProject.audio_duration,
            word_timestamps: allWordTimestamps,
            status: "processing",
          })
          .eq("id", currentProject.id);

        if (updateError) throw updateError;

        // Update local state
        setCurrentProject((prev) => ({
          ...prev,
          transcript: fullTranscript,
          audio_duration: totalDuration || prev.audio_duration,
          status: "processing" as const,
        }));

        toast.success(`Transcription complete! Duration: ${Math.round(totalDuration)}s, ${allWordTimestamps.length} words`);
        onRefresh();
        return;
      }

      // Small audio: use the original single-file transcription function
      const { data, error } = await supabase.functions.invoke('transcribe', {
        body: {
          projectId: currentProject.id,
          audioUrl: currentProject.audio_url,
        },
      });

      if (error) throw error;
      if (!data.success) throw new Error(data.error || 'Transcription failed');

      setCurrentProject(prev => ({
        ...prev,
        transcript: data.transcript,
        audio_duration: data.duration,
        status: 'processing' as const,
      }));

      toast.success(`Transcription complete! Duration: ${Math.round(data.duration)}s`);
      onRefresh();
    } catch (error: any) {
      console.error("Transcription error:", error);
      toast.error(error.message || "Failed to transcribe audio");
    } finally {
      setProcessing(null);
    }
  };

  const handleGenerateScenes = async () => {
    if (!currentProject.transcript) {
      toast.error("No transcript available. Generate timestamps first.");
      return;
    }

    setProcessing("scenes");
    toast.info("Generating scenes with AI... This may take a minute.");

    try {
      const { data, error } = await supabase.functions.invoke('generate-scenes', {
        body: {
          projectId: currentProject.id,
          transcript: currentProject.transcript,
          audioDuration: currentProject.audio_duration,
        },
      });

      if (error) throw error;
      if (!data.success) throw new Error(data.error || 'Scene generation failed');

      toast.success(`Generated ${data.count} scenes!`);
      
      // Refresh scenes list
      await fetchScenes();
      onRefresh();
    } catch (error: any) {
      console.error("Scene generation error:", error);
      toast.error(error.message || "Failed to generate scenes");
    } finally {
      setProcessing(null);
    }
  };

  const handleRenderProject = async () => {
    const isMusicVideoProject = (currentProject as any).project_type === 'music';
    
    if (scenes.length === 0) {
      toast.error(isMusicVideoProject ? "No scenes to render. Add images to your scenes first." : "No scenes to render. Generate scenes first.");
      return;
    }

    setProcessing("render");
    setRenderProgress(5);
    toast.info(isMusicVideoProject ? "Starting music video render..." : "Starting video render with AI... This may take several minutes.");

    // Progress simulation while waiting for actual render
    const progressInterval = setInterval(() => {
      setRenderProgress((prev) => {
        if (prev >= 90) return prev;
        return prev + Math.random() * 5;
      });
    }, 3000);

    try {
      // Find the thumbnail scene image URL if selected
      const thumbnailScene = thumbnailSceneId ? scenes.find(s => s.id === thumbnailSceneId) : null;
      
      // Parse word timestamps if available
      let wordTimestamps: Array<{ word: string; start: number; end: number }> = [];
      try {
        const rawTimestamps = (currentProject as any).word_timestamps;
        if (rawTimestamps) {
          wordTimestamps = typeof rawTimestamps === 'string' 
            ? JSON.parse(rawTimestamps) 
            : rawTimestamps;
        }
      } catch (e) {
        console.warn('Failed to parse word timestamps:', e);
      }

      const { data, error } = await supabase.functions.invoke('render-video', {
        body: {
          projectId: currentProject.id,
          projectType: (currentProject as any).project_type || 'narration',
          scenes: scenes.map(s => ({
            id: s.id,
            scene_number: s.scene_number,
            start_time: s.start_time,
            end_time: s.end_time,
            narration: s.narration,
            visual_prompt: s.visual_prompt,
            image_url: s.image_url,
            image_urls: (s as any).image_urls || [],
            image_durations: (s as any).image_durations || [],
            video_url: s.video_url,
          })),
          audioUrl: currentProject.audio_url,
          audioDuration: currentProject.audio_duration,
          thumbnailImageUrl: thumbnailScene?.image_url || null,
          projectTitle: currentProject.title,
          wordTimestamps,
        },
      });

      clearInterval(progressInterval);

      if (error) throw error;
      if (!data.success) throw new Error(data.error || 'Render failed');

      setRenderProgress(100);
      setCurrentProject(prev => ({ ...prev, status: "completed" as const }));
      
      // Refresh scenes to get updated image URLs
      await fetchScenes();
      
      toast.success(`Render complete! Generated ${data.imageCount} images. Check the Finished tab.`);
      onRefresh();
    } catch (error: any) {
      clearInterval(progressInterval);
      console.error("Render error:", error);
      toast.error(error.message || "Failed to render video");
    } finally {
      setProcessing(null);
      setRenderProgress(0);
    }
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      draft: "secondary",
      processing: "outline",
      ready: "default",
      rendering: "outline",
      completed: "default",
      error: "destructive",
    };
    return (
      <Badge variant={variants[status] || "secondary"} className="capitalize">
        {status}
      </Badge>
    );
  };

  const imageCount = scenes.filter((s) => s.image_url).length;

  const isMusicVideo = (currentProject as any).project_type === 'music';

  return (
    <div className="space-y-6">
      {/* Action Buttons */}
      <div className="flex flex-wrap gap-3">
        {!isMusicVideo && (
          <>
            <Button
              onClick={handleGenerateTimestamps}
              disabled={!!processing || !currentProject.audio_url}
              className="bg-primary hover:bg-primary/90"
            >
              {processing === "timestamps" ? (
                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Wand2 className="h-4 w-4 mr-2" />
              )}
              {currentProject.transcript ? "Re-generate Timestamps" : "Generate Timestamps"}
            </Button>
            <Button
              onClick={handleGenerateScenes}
              disabled={!!processing || !currentProject.transcript}
              variant="outline"
            >
              {processing === "scenes" ? (
                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Layers className="h-4 w-4 mr-2" />
              )}
              Generate Scenes
            </Button>
          </>
        )}
        <div className="flex items-center gap-3">
          <Button
            onClick={handleRenderProject}
            disabled={!!processing || scenes.length === 0}
            variant={isMusicVideo ? "default" : "outline"}
            className={isMusicVideo ? "bg-primary hover:bg-primary/90" : ""}
          >
            {processing === "render" ? (
              <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            Render {isMusicVideo ? "Music Video" : "Project"}
          </Button>
          {processing === "render" && (
            <div className="flex items-center gap-2 min-w-[150px]">
              <Progress value={Math.min(renderProgress, 100)} className="h-2" />
              <span className="text-sm text-muted-foreground">{Math.round(Math.min(renderProgress, 100))}%</span>
            </div>
          )}
        </div>
        <Separator orientation="vertical" className="h-9" />
        
        {/* DaVinci Resolve Export Dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="gap-2">
              <FileVideo className="h-4 w-4" />
              Export for DaVinci
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Complete Bundle</DropdownMenuLabel>
            <DropdownMenuItem
              onClick={async () => {
                if (scenes.length === 0) {
                  toast.error('No scenes to export');
                  return;
                }
                toast.info('Creating DaVinci bundle... This may take a moment.');
                try {
                  await downloadDaVinciBundle(
                    currentProject.title,
                    scenes,
                    wordTimestamps,
                    currentProject.audio_url,
                    currentProject.audio_duration || 0,
                    (stage, current, total) => {
                      console.log(`${stage}: ${current}/${total}`);
                    }
                  );
                  toast.success('DaVinci bundle downloaded!');
                } catch (error) {
                  console.error('Bundle error:', error);
                  toast.error('Failed to create bundle');
                }
              }}
              disabled={scenes.length === 0}
              className="font-medium"
            >
              <Archive className="h-4 w-4 mr-2" />
              Download ZIP Bundle (All Files)
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Individual Files</DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => {
                const edl = generateEDL(currentProject.title, scenes);
                downloadFile(edl, `${currentProject.title.replace(/\s+/g, '_')}.edl`, 'text/plain');
                toast.success('EDL file downloaded!');
              }}
              disabled={scenes.length === 0}
            >
              <FileText className="h-4 w-4 mr-2" />
              Download EDL Timeline
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                const csv = generateSceneCSV(currentProject.title, scenes);
                downloadFile(csv, `${currentProject.title.replace(/\s+/g, '_')}_scenes.csv`, 'text/csv');
                toast.success('Scene list CSV downloaded!');
              }}
              disabled={scenes.length === 0}
            >
              <FileText className="h-4 w-4 mr-2" />
              Download Scene List (CSV)
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={async () => {
                const images = getSceneImages(scenes);
                if (images.length === 0) {
                  toast.error('No images to download');
                  return;
                }
                toast.info(`Downloading ${images.length} images...`);
                await downloadAllImages(scenes, (current, total) => {
                  if (current === total) {
                    toast.success(`Downloaded ${total} images!`);
                  }
                });
              }}
              disabled={scenes.length === 0}
            >
              <Images className="h-4 w-4 mr-2" />
              Download All Images
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Subtitles</DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => {
                if (wordTimestamps.length === 0) {
                  toast.error('No word timestamps available. Generate timestamps first.');
                  return;
                }
                const srt = generateSRT(wordTimestamps);
                downloadFile(srt, `${currentProject.title.replace(/\s+/g, '_')}.srt`, 'text/plain');
                toast.success('SRT subtitles downloaded!');
              }}
              disabled={wordTimestamps.length === 0}
            >
              <FileText className="h-4 w-4 mr-2" />
              Download SRT Subtitles
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                if (wordTimestamps.length === 0) {
                  toast.error('No word timestamps available. Generate timestamps first.');
                  return;
                }
                const vtt = generateVTT(wordTimestamps);
                downloadFile(vtt, `${currentProject.title.replace(/\s+/g, '_')}.vtt`, 'text/plain');
                toast.success('VTT subtitles downloaded!');
              }}
              disabled={wordTimestamps.length === 0}
            >
              <FileText className="h-4 w-4 mr-2" />
              Download VTT Subtitles
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Project Stats */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg flex items-center gap-2">
              <Film className="h-5 w-5 text-primary" />
              {currentProject.title}
              {isMusicVideo && (
                <Badge variant="secondary" className="ml-2">Music Video</Badge>
              )}
            </CardTitle>
            {getStatusBadge(currentProject.status)}
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Scenes:</span>
              <span className="font-medium">{scenes.length}</span>
            </div>
            <div className="flex items-center gap-2">
              <Image className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Images:</span>
              <span className="font-medium">{imageCount}</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Created:</span>
              <span className="font-medium">
                {formatDistanceToNow(new Date(project.created_at), { addSuffix: true })}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Audio Player */}
      {currentProject.audio_url && (
        <Card className="bg-card border-border">
          <CardContent className="py-4">
            <audio
              ref={audioRef}
              src={currentProject.audio_url}
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={handleLoadedMetadata}
              onEnded={handleAudioEnded}
              className="hidden"
            />
            <div className="flex items-center gap-4">
              <Button
                variant="outline"
                size="icon"
                onClick={togglePlayPause}
                className="h-10 w-10 shrink-0"
              >
                {isPlaying ? (
                  <Pause className="h-4 w-4" />
                ) : (
                  <Play className="h-4 w-4 ml-0.5" />
                )}
              </Button>
              
              <div className="flex-1 space-y-1">
                <Slider
                  value={[audioProgress]}
                  max={audioDuration || 100}
                  step={0.1}
                  onValueChange={handleSeek}
                  className="cursor-pointer"
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{formatTime(audioProgress)}</span>
                  <span>{formatTime(audioDuration)}</span>
                </div>
              </div>
              
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={toggleMute}
                  className="h-8 w-8"
                >
                  {isMuted ? (
                    <VolumeX className="h-4 w-4" />
                  ) : (
                    <Volume2 className="h-4 w-4" />
                  )}
                </Button>
                <Slider
                  value={[isMuted ? 0 : volume]}
                  max={1}
                  step={0.01}
                  onValueChange={handleVolumeChange}
                  className="w-20 cursor-pointer"
                />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center gap-4 text-sm">
        <div className="flex items-center gap-2">
          <CheckCircle className="h-4 w-4 text-green-400" />
          <span className="text-muted-foreground">Whisper API</span>
        </div>
        <div className="flex items-center gap-2">
          <CheckCircle className="h-4 w-4 text-green-400" />
          <span className="text-muted-foreground">Claude API</span>
        </div>
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-yellow-400" />
          <span className="text-muted-foreground">FFmpeg (Serverless)</span>
        </div>
      </div>

      {/* Scene Navigation */}
      {scenes.length > 0 && (
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-foreground">Scenes ({scenes.length})</h3>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={expandAll}>
              Expand All
            </Button>
            <Button variant="ghost" size="sm" onClick={collapseAll}>
              Collapse All
            </Button>
          </div>
        </div>
      )}

      {/* Scenes List */}
      <div className="space-y-3">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : scenes.length === 0 ? (
          <Card className="bg-card border-border">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Layers className="h-16 w-16 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-2">No Scenes Yet</h3>
              <p className="text-muted-foreground max-w-sm">
                Generate timestamps first, then generate scenes to break your narration into visual segments.
              </p>
            </CardContent>
          </Card>
        ) : (
          scenes.map((scene) => (
            <SceneCard
              key={scene.id}
              scene={scene}
              isExpanded={expandedScenes.has(scene.id)}
              onToggle={() => toggleScene(scene.id)}
              onUpdate={fetchScenes}
              projectId={project.id}
              isThumbnailScene={thumbnailSceneId === scene.id}
              onSetThumbnail={handleSetThumbnail}
            />
          ))
        )}
      </div>
    </div>
  );
}
