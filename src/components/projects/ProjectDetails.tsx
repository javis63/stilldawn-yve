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
} from "lucide-react";
import { Project, Scene } from "@/types/project";
import { supabase } from "@/integrations/supabase/client";
import { formatDistanceToNow } from "date-fns";
import { SceneCard } from "./SceneCard";
import { toast } from "sonner";
import { Progress } from "@/components/ui/progress";

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

  // Fetch thumbnail scene id from project
  useEffect(() => {
    const fetchThumbnailSceneId = async () => {
      const { data } = await supabase
        .from("projects")
        .select("thumbnail_scene_id")
        .eq("id", project.id)
        .single();
      
      if (data?.thumbnail_scene_id) {
        setThumbnailSceneId(data.thumbnail_scene_id);
      }
    };
    fetchThumbnailSceneId();
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
    toast.info("Generating timestamps with Whisper... This may take a minute.");

    try {
      const { data, error } = await supabase.functions.invoke('transcribe', {
        body: {
          projectId: currentProject.id,
          audioUrl: currentProject.audio_url,
        },
      });

      if (error) throw error;
      if (!data.success) throw new Error(data.error || 'Transcription failed');

      // Update local project state
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
            video_url: s.video_url,
          })),
          audioUrl: currentProject.audio_url,
          audioDuration: currentProject.audio_duration,
          thumbnailImageUrl: thumbnailScene?.image_url || null,
          projectTitle: currentProject.title,
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
        <Button variant="ghost" size="icon">
          <Download className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon">
          <Upload className="h-4 w-4" />
        </Button>
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
