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
  Plus,
  X,
  GripVertical,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Scene, TransitionType } from "@/types/project";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface SceneCardProps {
  scene: Scene & { image_urls?: string[] };
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
  const [uploading, setUploading] = useState(false);

  // Get all images (combine image_url with image_urls array)
  const getAllImages = (): string[] => {
    const images: string[] = [];
    if (scene.image_url) images.push(scene.image_url);
    if (scene.image_urls && Array.isArray(scene.image_urls)) {
      scene.image_urls.forEach(url => {
        if (url && !images.includes(url)) images.push(url);
      });
    }
    return images;
  };

  const allImages = getAllImages();

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

  const handleAddImage = async (file: File) => {
    setUploading(true);
    try {
      const timestamp = Date.now();
      const filePath = `${scene.project_id}/${scene.id}_${timestamp}.${file.name.split(".").pop()}`;

      const { error: uploadError } = await supabase.storage
        .from("images")
        .upload(filePath, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage.from("images").getPublicUrl(filePath);
      const newImageUrl = urlData.publicUrl;

      // Update image_urls array
      const currentUrls = scene.image_urls || [];
      const updatedUrls = [...currentUrls, newImageUrl];

      // If this is the first image, also set image_url
      const updateData: any = { image_urls: updatedUrls };
      if (!scene.image_url) {
        updateData.image_url = newImageUrl;
      }

      const { error: updateError } = await supabase
        .from("scenes")
        .update(updateData)
        .eq("id", scene.id);

      if (updateError) throw updateError;

      toast.success("Image added");
      onUpdate();
    } catch (error: any) {
      toast.error(error.message || "Failed to upload image");
    } finally {
      setUploading(false);
    }
  };

  const handleRemoveImage = async (imageUrl: string) => {
    try {
      const currentUrls = scene.image_urls || [];
      const updatedUrls = currentUrls.filter(url => url !== imageUrl);
      
      const updateData: any = { image_urls: updatedUrls };
      
      // If removing the primary image, set first remaining as primary
      if (scene.image_url === imageUrl) {
        updateData.image_url = updatedUrls[0] || null;
      }

      const { error } = await supabase
        .from("scenes")
        .update(updateData)
        .eq("id", scene.id);

      if (error) throw error;

      toast.success("Image removed");
      onUpdate();
    } catch (error: any) {
      toast.error(error.message || "Failed to remove image");
    }
  };

  const handleSetPrimaryImage = async (imageUrl: string) => {
    try {
      const { error } = await supabase
        .from("scenes")
        .update({ image_url: imageUrl })
        .eq("id", scene.id);

      if (error) throw error;

      toast.success("Primary image set");
      onUpdate();
    } catch (error: any) {
      toast.error(error.message || "Failed to set primary image");
    }
  };

  const handleVideoUpload = async (file: File) => {
    try {
      const filePath = `${scene.project_id}/${scene.id}.${file.name.split(".").pop()}`;

      const { error: uploadError } = await supabase.storage
        .from("videos")
        .upload(filePath, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage.from("videos").getPublicUrl(filePath);

      const { error: updateError } = await supabase
        .from("scenes")
        .update({ video_url: urlData.publicUrl })
        .eq("id", scene.id);

      if (updateError) throw updateError;

      toast.success("Video uploaded");
      onUpdate();
    } catch (error: any) {
      toast.error(error.message || "Failed to upload video");
    }
  };

  const duration = scene.end_time - scene.start_time;
  const durationMinutes = Math.floor(duration / 60);
  const durationSeconds = Math.floor(duration % 60);

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
                {allImages.length > 1 ? `${allImages.length} images` : scene.scene_type}
              </Badge>
              <span className="text-sm text-muted-foreground font-mono">
                {formatTime(scene.start_time)} - {formatTime(scene.end_time)}
              </span>
              <span className="text-xs text-muted-foreground">
                ({durationMinutes}m {durationSeconds}s)
              </span>
              <div className="flex-1" />
              {/* Show thumbnail previews of all images */}
              <div className="flex -space-x-2">
                {allImages.slice(0, 4).map((url, idx) => (
                  <div key={idx} className="h-8 w-12 rounded overflow-hidden border-2 border-background">
                    <img
                      src={url}
                      alt={`Scene ${scene.scene_number} image ${idx + 1}`}
                      className="h-full w-full object-cover"
                    />
                  </div>
                ))}
                {allImages.length > 4 && (
                  <div className="h-8 w-12 rounded overflow-hidden border-2 border-background bg-muted flex items-center justify-center">
                    <span className="text-xs text-muted-foreground">+{allImages.length - 4}</span>
                  </div>
                )}
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="pt-0 space-y-4">
            {/* Ken Burns Notice */}
            <div className="bg-primary/10 border border-primary/20 rounded-lg p-3">
              <p className="text-sm text-primary">
                <strong>Ken Burns Effect:</strong> Each image will have dynamic pan/zoom animations applied for the full duration it's displayed.
                {allImages.length > 1 && ` Images will cycle with ${Math.round(duration / allImages.length)}s per image.`}
              </p>
            </div>

            {/* Thumbnail Toggle & Transition Selector */}
            <div className="flex items-center justify-between gap-4 flex-wrap">
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
              <div className="text-sm text-muted-foreground bg-muted/50 rounded-md p-3 max-h-32 overflow-y-auto">
                {scene.narration}
              </div>
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

            {/* Multiple Images Section */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-foreground">
                  Images ({allImages.length}) - Each with Ken Burns Effect
                </label>
                <label className="cursor-pointer">
                  <Button variant="outline" size="sm" disabled={uploading} asChild>
                    <span>
                      <Plus className="h-4 w-4 mr-1" />
                      {uploading ? "Uploading..." : "Add Image"}
                    </span>
                  </Button>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files?.[0]) {
                        handleAddImage(e.target.files[0]);
                      }
                    }}
                  />
                </label>
              </div>

              {allImages.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                  {allImages.map((url, idx) => (
                    <div
                      key={idx}
                      className={`relative aspect-video rounded-lg overflow-hidden border-2 ${
                        url === scene.image_url ? "border-primary" : "border-border"
                      } group`}
                    >
                      <img
                        src={url}
                        alt={`Scene ${scene.scene_number} image ${idx + 1}`}
                        className="w-full h-full object-cover"
                      />
                      {url === scene.image_url && (
                        <Badge className="absolute top-1 left-1 text-xs" variant="default">
                          Primary
                        </Badge>
                      )}
                      <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                        {url !== scene.image_url && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleSetPrimaryImage(url)}
                          >
                            Set Primary
                          </Button>
                        )}
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => handleRemoveImage(url)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <label className="flex flex-col items-center justify-center aspect-video max-w-md rounded-lg border-2 border-dashed border-border hover:border-primary/50 cursor-pointer transition-colors bg-muted/30">
                  <Image className="h-8 w-8 text-muted-foreground mb-2" />
                  <span className="text-sm text-muted-foreground">Upload First Image</span>
                  <span className="text-xs text-muted-foreground mt-1">Ken Burns effect will be applied automatically</span>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files?.[0]) {
                        handleAddImage(e.target.files[0]);
                      }
                    }}
                  />
                </label>
              )}
            </div>

            {/* Video Upload (Optional) */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Video (Optional - overrides images)</label>
              {scene.video_url ? (
                <div className="relative aspect-video max-w-md rounded-lg overflow-hidden border border-border">
                  <video
                    src={scene.video_url}
                    className="w-full h-full object-cover"
                    muted
                    controls
                  />
                  <label className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 hover:opacity-100 transition-opacity cursor-pointer">
                    <Upload className="h-6 w-6 text-white" />
                    <input
                      type="file"
                      accept="video/*"
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files?.[0]) {
                          handleVideoUpload(e.target.files[0]);
                        }
                      }}
                    />
                  </label>
                </div>
              ) : (
                <label className="flex flex-col items-center justify-center aspect-video max-w-md rounded-lg border-2 border-dashed border-border hover:border-primary/50 cursor-pointer transition-colors bg-muted/30">
                  <Video className="h-8 w-8 text-muted-foreground mb-2" />
                  <span className="text-sm text-muted-foreground">Upload Video</span>
                  <input
                    type="file"
                    accept="video/*"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files?.[0]) {
                        handleVideoUpload(e.target.files[0]);
                      }
                    }}
                  />
                </label>
              )}
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}