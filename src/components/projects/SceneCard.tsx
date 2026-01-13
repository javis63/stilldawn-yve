import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import {
  ChevronDown,
  ChevronRight,
  Image,
  Video,
  Upload,
  Copy,
  Check,
  ImageIcon,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Scene, TransitionType } from "@/types/project";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface SceneCardProps {
  scene: Scene;
  isExpanded: boolean;
  onToggle: () => void;
  onUpdate: () => void;
  projectId: string;
  isThumbnailScene: boolean;
  onSetThumbnail: (sceneId: string | null) => void;
}

const TRANSITIONS: { value: TransitionType; label: string }[] = [
  { value: "crossfade", label: "Crossfade" },
  { value: "hard_cut", label: "Hard Cut" },
  { value: "zoom_in", label: "Zoom In" },
  { value: "zoom_out", label: "Zoom Out" },
  { value: "fade_to_black", label: "Fade to Black" },
  { value: "slide_left", label: "Slide Left" },
  { value: "slide_right", label: "Slide Right" },
];

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function SceneCard({ scene, isExpanded, onToggle, onUpdate, projectId, isThumbnailScene, onSetThumbnail }: SceneCardProps) {
  const [visualPrompt, setVisualPrompt] = useState(scene.visual_prompt || "");
  const [transition, setTransition] = useState<TransitionType>(scene.transition);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleCopyPrompt = async () => {
    if (visualPrompt) {
      await navigator.clipboard.writeText(visualPrompt);
      setCopied(true);
      toast.success("Prompt copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleSavePrompt = async () => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("scenes")
        .update({ visual_prompt: visualPrompt })
        .eq("id", scene.id);

      if (error) throw error;
      toast.success("Prompt saved");
    } catch (error: any) {
      toast.error(error.message || "Failed to save prompt");
    } finally {
      setSaving(false);
    }
  };

  const handleTransitionChange = async (value: TransitionType) => {
    setTransition(value);
    try {
      const { error } = await supabase
        .from("scenes")
        .update({ transition: value })
        .eq("id", scene.id);

      if (error) throw error;
    } catch (error: any) {
      toast.error(error.message || "Failed to update transition");
    }
  };

  const handleFileUpload = async (file: File, type: "image" | "video") => {
    try {
      const bucket = type === "image" ? "images" : "videos";
      const filePath = `${scene.project_id}/${scene.id}.${file.name.split(".").pop()}`;

      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(filePath, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(filePath);

      const updateField = type === "image" ? "image_url" : "video_url";
      const { error: updateError } = await supabase
        .from("scenes")
        .update({ [updateField]: urlData.publicUrl })
        .eq("id", scene.id);

      if (updateError) throw updateError;

      toast.success(`${type === "image" ? "Image" : "Video"} uploaded`);
      onUpdate();
    } catch (error: any) {
      toast.error(error.message || `Failed to upload ${type}`);
    }
  };

  const duration = scene.end_time - scene.start_time;

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggle}>
      <Card className="bg-card border-border">
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors py-3">
            <div className="flex items-center gap-3">
              {isExpanded ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
              <Badge variant="outline" className="font-mono">
                Scene {scene.scene_number}
              </Badge>
              <Badge variant="secondary" className="capitalize">
                {scene.scene_type === "image" ? (
                  <Image className="h-3 w-3 mr-1" />
                ) : (
                  <Video className="h-3 w-3 mr-1" />
                )}
                {scene.scene_type}
              </Badge>
              <span className="text-sm text-muted-foreground font-mono">
                {formatTime(scene.start_time)} - {formatTime(scene.end_time)}
              </span>
              <span className="text-xs text-muted-foreground">
                ({duration.toFixed(1)}s)
              </span>
              <div className="flex-1" />
              {scene.image_url && (
                <div className="h-8 w-12 rounded overflow-hidden">
                  <img
                    src={scene.image_url}
                    alt={`Scene ${scene.scene_number}`}
                    className="h-full w-full object-cover"
                  />
                </div>
              )}
            </div>
          </CardHeader>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="pt-0 space-y-4">
            {/* Thumbnail Toggle & Transition Selector */}
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <span className="text-sm text-muted-foreground">Transition:</span>
                <Select value={transition} onValueChange={handleTransitionChange}>
                  <SelectTrigger className="w-40 bg-background border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TRANSITIONS.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              {/* Thumbnail Toggle */}
              {scene.image_url && (
                <div className="flex items-center gap-2">
                  <ImageIcon className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Use as YouTube Thumbnail</span>
                  <Switch
                    checked={isThumbnailScene}
                    onCheckedChange={(checked) => onSetThumbnail(checked ? scene.id : null)}
                  />
                </div>
              )}
            </div>

            {/* Narration Text */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Narration</label>
              <p className="text-sm text-muted-foreground bg-muted/50 rounded-md p-3">
                {scene.narration}
              </p>
            </div>

            {/* Visual Prompt */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-foreground">Visual Prompt</label>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCopyPrompt}
                    disabled={!visualPrompt}
                  >
                    {copied ? (
                      <Check className="h-4 w-4 text-green-400" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleSavePrompt}
                    disabled={saving || visualPrompt === scene.visual_prompt}
                  >
                    {saving ? "Saving..." : "Save"}
                  </Button>
                </div>
              </div>
              <Textarea
                value={visualPrompt}
                onChange={(e) => setVisualPrompt(e.target.value)}
                placeholder="Enter visual prompt for image generation..."
                className="bg-background border-border min-h-[80px]"
              />
            </div>

            {/* Media Upload Zones */}
            <div className="grid grid-cols-2 gap-4">
              {/* Image Upload */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Image</label>
                {scene.image_url ? (
                  <div className="relative aspect-video rounded-lg overflow-hidden border border-border">
                    <img
                      src={scene.image_url}
                      alt={`Scene ${scene.scene_number}`}
                      className="w-full h-full object-cover"
                    />
                    <label className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 hover:opacity-100 transition-opacity cursor-pointer">
                      <Upload className="h-6 w-6 text-white" />
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          if (e.target.files?.[0]) {
                            handleFileUpload(e.target.files[0], "image");
                          }
                        }}
                      />
                    </label>
                  </div>
                ) : (
                  <label className="flex flex-col items-center justify-center aspect-video rounded-lg border-2 border-dashed border-border hover:border-primary/50 cursor-pointer transition-colors bg-muted/30">
                    <Image className="h-8 w-8 text-muted-foreground mb-2" />
                    <span className="text-sm text-muted-foreground">Upload Image</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files?.[0]) {
                          handleFileUpload(e.target.files[0], "image");
                        }
                      }}
                    />
                  </label>
                )}
              </div>

              {/* Video Upload */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Video (Optional)</label>
                {scene.video_url ? (
                  <div className="relative aspect-video rounded-lg overflow-hidden border border-border">
                    <video
                      src={scene.video_url}
                      className="w-full h-full object-cover"
                      muted
                    />
                    <label className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 hover:opacity-100 transition-opacity cursor-pointer">
                      <Upload className="h-6 w-6 text-white" />
                      <input
                        type="file"
                        accept="video/*"
                        className="hidden"
                        onChange={(e) => {
                          if (e.target.files?.[0]) {
                            handleFileUpload(e.target.files[0], "video");
                          }
                        }}
                      />
                    </label>
                  </div>
                ) : (
                  <label className="flex flex-col items-center justify-center aspect-video rounded-lg border-2 border-dashed border-border hover:border-primary/50 cursor-pointer transition-colors bg-muted/30">
                    <Video className="h-8 w-8 text-muted-foreground mb-2" />
                    <span className="text-sm text-muted-foreground">Upload Video</span>
                    <input
                      type="file"
                      accept="video/*"
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files?.[0]) {
                          handleFileUpload(e.target.files[0], "video");
                        }
                      }}
                    />
                  </label>
                )}
              </div>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
