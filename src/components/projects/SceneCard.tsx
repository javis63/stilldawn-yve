import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ChevronDown,
  ChevronRight,
  Image,
  Video,
  Upload,
  Clock,
  ImageIcon,
  Plus,
  X,
  Sparkles,
  Palette,
  Copy,
  Check,
  Loader2,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Scene, TransitionType } from "@/types/project";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface Part {
  part_number: number;
  start_time: number;
  end_time: number;
  duration: number;
  content: string;
  visual_prompt: string;
}

interface SceneCardProps {
  scene: Scene & { image_urls?: string[]; image_durations?: number[]; parts?: Part[] };
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

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

export function SceneCard({ scene, isExpanded, onToggle, onUpdate, projectId, isThumbnailScene, onSetThumbnail }: SceneCardProps) {
  const [transition, setTransition] = useState<TransitionType>(scene.transition);
  const [uploading, setUploading] = useState(false);
  const [imageDurations, setImageDurations] = useState<number[]>(scene.image_durations || []);
  const [generatingParts, setGeneratingParts] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState<number | null>(null);
  const [partsExpanded, setPartsExpanded] = useState(true);

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
  const sceneDuration = scene.end_time - scene.start_time;
  const parts = scene.parts || [];

  // Calculate default duration per image (evenly distributed)
  const getDefaultDuration = (imageCount: number) => {
    if (imageCount === 0) return 0;
    return sceneDuration / imageCount;
  };

  const handleGenerateParts = async () => {
    setGeneratingParts(true);
    try {
      const { data, error } = await supabase.functions.invoke('generate-scene-parts', {
        body: { sceneId: scene.id, projectId }
      });

      if (error) throw error;
      if (!data.success) throw new Error(data.error || 'Failed to generate parts');

      toast.success(`Generated ${data.count} parts`);
      onUpdate();
    } catch (error: any) {
      console.error('Parts generation error:', error);
      toast.error(error.message || 'Failed to generate parts');
    } finally {
      setGeneratingParts(false);
    }
  };

  const handleCopyPrompt = async (prompt: string, partNumber: number) => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopiedPrompt(partNumber);
      toast.success('Prompt copied to clipboard');
      setTimeout(() => setCopiedPrompt(null), 2000);
    } catch {
      toast.error('Failed to copy');
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
      
      // Add default duration for new image
      const newDurations = [...imageDurations, 0]; // 0 means "auto"
      updateData.image_durations = newDurations;
      setImageDurations(newDurations);

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

  const handleRemoveImage = async (imageUrl: string, index: number) => {
    try {
      const currentUrls = scene.image_urls || [];
      const updatedUrls = currentUrls.filter(url => url !== imageUrl);
      
      // Remove duration for this image
      const newDurations = [...imageDurations];
      newDurations.splice(index, 1);
      
      const updateData: any = { 
        image_urls: updatedUrls,
        image_durations: newDurations
      };
      
      // If removing the primary image, set first remaining as primary
      if (scene.image_url === imageUrl) {
        updateData.image_url = updatedUrls[0] || null;
      }

      const { error } = await supabase
        .from("scenes")
        .update(updateData)
        .eq("id", scene.id);

      if (error) throw error;

      setImageDurations(newDurations);
      toast.success("Image removed");
      onUpdate();
    } catch (error: any) {
      toast.error(error.message || "Failed to remove image");
    }
  };

  const handleDurationChange = async (index: number, duration: number) => {
    const newDurations = [...imageDurations];
    newDurations[index] = duration;
    setImageDurations(newDurations);
    
    try {
      const { error } = await supabase
        .from("scenes")
        .update({ image_durations: newDurations })
        .eq("id", scene.id);

      if (error) throw error;
    } catch (error: any) {
      toast.error(error.message || "Failed to save duration");
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
              {parts.length > 0 && (
                <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20">
                  {parts.length} parts
                </Badge>
              )}
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
            {/* Parts Breakdown Section */}
            <div className="space-y-3 border border-border rounded-lg p-4 bg-muted/20">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium">Parts Breakdown</span>
                  <span className="text-xs text-muted-foreground">(uses Whisper timestamps for timing)</span>
                </div>
                <div className="flex items-center gap-2">
                  {parts.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPartsExpanded(!partsExpanded)}
                      className="h-7 text-xs"
                    >
                      {partsExpanded ? "Collapse" : "Expand"}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleGenerateParts}
                    disabled={generatingParts}
                    className="h-8"
                  >
                    {generatingParts ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4 mr-1" />
                        {parts.length > 0 ? "Regenerate Parts" : "Generate Parts"}
                      </>
                    )}
                  </Button>
                </div>
              </div>

              {parts.length > 0 && partsExpanded && (
                <div className="space-y-3 mt-3">
                  {parts.map((part) => (
                    <div key={part.part_number} className="border border-border rounded-lg bg-card overflow-hidden">
                      <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 border-b border-border">
                        <Badge variant="secondary" className="font-mono text-xs">
                          Part {part.part_number}
                        </Badge>
                        <span className="text-xs text-muted-foreground font-mono">
                          {formatTime(part.start_time)} - {formatTime(part.end_time)}
                        </span>
                        <Badge variant="outline" className="text-xs">
                          <Clock className="h-3 w-3 mr-1" />
                          {formatDuration(part.duration)}
                        </Badge>
                      </div>
                      
                      <div className="p-3 space-y-3">
                        {/* Part content - full narration, no truncation */}
                        <div className="bg-muted/30 rounded-md p-3">
                          <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                            "{part.content}"
                          </p>
                        </div>
                        
                        {/* Visual prompt */}
                        <div className="bg-primary/5 border border-primary/20 rounded-md p-2">
                          <div className="flex items-start gap-2">
                            <Palette className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
                            <p className="text-sm text-primary flex-1">
                              {part.visual_prompt}
                            </p>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0 flex-shrink-0"
                              onClick={() => handleCopyPrompt(part.visual_prompt, part.part_number)}
                            >
                              {copiedPrompt === part.part_number ? (
                                <Check className="h-3 w-3 text-green-500" />
                              ) : (
                                <Copy className="h-3 w-3 text-muted-foreground" />
                              )}
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {parts.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  Click "Generate Parts" to break down this scene into logical story segments with AI-generated visual prompts.
                </p>
              )}
            </div>

            {/* Motion Notice */}
            <div className="bg-primary/10 border border-primary/20 rounded-lg p-3">
              <p className="text-sm text-primary">
                <strong>Motion:</strong> The current renderer uses simple slideshow transitions. (Ken Burns-style pan/zoom isn’t enabled yet.)
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

            {/* Narration Text - Scrollable */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Narration</label>
              <ScrollArea className="h-48 rounded-md border border-border bg-muted/50">
                <div className="p-3 text-sm text-muted-foreground whitespace-pre-wrap">
                  {scene.narration}
                </div>
              </ScrollArea>
            </div>

            {/* Multiple Images Section with Duration Controls */}
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
                <div className="space-y-3">
                  {allImages.map((url, idx) => {
                    const customDuration = imageDurations[idx] || 0;
                    const displayDuration = customDuration > 0 ? customDuration : getDefaultDuration(allImages.length);
                    
                    return (
                      <div key={idx} className="flex items-start gap-3 p-3 rounded-lg bg-muted/30 border border-border">
                        {/* Image thumbnail */}
                        <div className={`relative w-32 h-20 rounded overflow-hidden border-2 flex-shrink-0 ${
                          url === scene.image_url ? "border-primary" : "border-border"
                        }`}>
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
                        </div>
                        
                        {/* Duration control */}
                        <div className="flex-1 space-y-2">
                          <div className="flex items-center gap-2">
                            <Clock className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm text-muted-foreground">Duration:</span>
                            <Input
                              type="number"
                              min="0"
                              step="1"
                              placeholder="Auto"
                              value={customDuration > 0 ? customDuration : ""}
                              onChange={(e) => handleDurationChange(idx, parseFloat(e.target.value) || 0)}
                              className="w-20 h-8 text-sm"
                            />
                            <span className="text-xs text-muted-foreground">
                              sec {customDuration === 0 && `(auto: ${displayDuration.toFixed(1)}s)`}
                            </span>
                          </div>
                          
                          {/* Actions */}
                          <div className="flex items-center gap-2">
                            {url !== scene.image_url && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleSetPrimaryImage(url)}
                                className="h-7 text-xs"
                              >
                                Set Primary
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRemoveImage(url, idx)}
                              className="h-7 text-xs text-destructive hover:text-destructive"
                            >
                              <X className="h-3 w-3 mr-1" />
                              Remove
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <label className="flex flex-col items-center justify-center aspect-video max-w-md rounded-lg border-2 border-dashed border-border hover:border-primary/50 cursor-pointer transition-colors bg-muted/30">
                  <Image className="h-8 w-8 text-muted-foreground mb-2" />
                  <span className="text-sm text-muted-foreground">Upload First Image</span>
                  <span className="text-xs text-muted-foreground mt-1">A slideshow video will be generated from your images</span>
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
