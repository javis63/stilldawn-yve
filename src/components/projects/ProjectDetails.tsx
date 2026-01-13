import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Wand2,
  Layers,
  Play,
  Download,
  Upload,
  RefreshCw,
  Film,
  Clock,
  Image,
  CheckCircle,
  AlertCircle,
} from "lucide-react";
import { Project, Scene } from "@/types/project";
import { supabase } from "@/integrations/supabase/client";
import { formatDistanceToNow } from "date-fns";
import { SceneCard } from "./SceneCard";
import { toast } from "sonner";

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

  // Keep local project state in sync with prop
  useEffect(() => {
    setCurrentProject(project);
  }, [project]);

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
    setProcessing("scenes");
    toast.info("Generating scenes with AI...");
    // TODO: Implement Claude scene generation
    setTimeout(() => {
      setProcessing(null);
      toast.success("Scenes generated!");
    }, 2000);
  };

  const handleRenderProject = async () => {
    setProcessing("render");
    toast.info("Starting render...");
    // TODO: Implement FFmpeg rendering
    setTimeout(() => {
      setProcessing(null);
      toast.success("Render started!");
    }, 2000);
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

  return (
    <div className="space-y-6">
      {/* Action Buttons */}
      <div className="flex flex-wrap gap-3">
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
        <Button
          onClick={handleRenderProject}
          disabled={!!processing || scenes.length === 0}
          variant="outline"
        >
          {processing === "render" ? (
            <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Play className="h-4 w-4 mr-2" />
          )}
          Render Project
        </Button>
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

      {/* API Status */}
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
            />
          ))
        )}
      </div>
    </div>
  );
}
