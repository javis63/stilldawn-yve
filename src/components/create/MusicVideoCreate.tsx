import { useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { 
  Upload, 
  Music, 
  Loader2, 
  Plus,
  Trash2,
  Play,
  Pause,
  Image as ImageIcon,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";

interface MusicVideoCreateProps {
  onProjectCreated: (projectId: string) => void;
}

interface MusicScene {
  id: string;
  imageFile: File | null;
  imagePreview: string | null;
  startTime: number;
  endTime: number;
}

export function MusicVideoCreate({ onProjectCreated }: MusicVideoCreateProps) {
  const { user } = useAuth();
  const [title, setTitle] = useState("");
  const [musicFile, setMusicFile] = useState<File | null>(null);
  const [musicDuration, setMusicDuration] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [scenes, setScenes] = useState<MusicScene[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile.type.startsWith("audio/") || droppedFile.name.match(/\.(mp3|wav|m4a|ogg)$/i)) {
        handleMusicFile(droppedFile);
      } else {
        toast.error("Please upload an audio file (MP3, WAV, M4A, OGG)");
      }
    }
  }, []);

  const handleMusicFile = (file: File) => {
    setMusicFile(file);
    if (!title) {
      setTitle(file.name.replace(/\.[^/.]+$/, ""));
    }

    // Get duration
    const audio = new Audio();
    audio.src = URL.createObjectURL(file);
    audio.onloadedmetadata = () => {
      setMusicDuration(audio.duration);
      // Initialize with one scene covering full duration
      setScenes([{
        id: crypto.randomUUID(),
        imageFile: null,
        imagePreview: null,
        startTime: 0,
        endTime: audio.duration,
      }]);
    };
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleMusicFile(e.target.files[0]);
    }
  };

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
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const addScene = () => {
    if (scenes.length === 0) {
      setScenes([{
        id: crypto.randomUUID(),
        imageFile: null,
        imagePreview: null,
        startTime: 0,
        endTime: musicDuration,
      }]);
      return;
    }

    const lastScene = scenes[scenes.length - 1];
    const midPoint = lastScene.startTime + (lastScene.endTime - lastScene.startTime) / 2;

    // Split the last scene
    setScenes(prev => [
      ...prev.slice(0, -1),
      { ...lastScene, endTime: midPoint },
      {
        id: crypto.randomUUID(),
        imageFile: null,
        imagePreview: null,
        startTime: midPoint,
        endTime: lastScene.endTime,
      }
    ]);
  };

  const removeScene = (sceneId: string) => {
    if (scenes.length <= 1) {
      toast.error("You need at least one scene");
      return;
    }

    const sceneIndex = scenes.findIndex(s => s.id === sceneId);
    const scene = scenes[sceneIndex];

    setScenes(prev => {
      const newScenes = prev.filter(s => s.id !== sceneId);
      // Adjust adjacent scene times
      if (sceneIndex > 0) {
        newScenes[sceneIndex - 1] = {
          ...newScenes[sceneIndex - 1],
          endTime: scene.endTime,
        };
      } else if (newScenes.length > 0) {
        newScenes[0] = {
          ...newScenes[0],
          startTime: scene.startTime,
        };
      }
      return newScenes;
    });
  };

  const handleSceneImageUpload = (sceneId: string, file: File) => {
    const preview = URL.createObjectURL(file);
    setScenes(prev => prev.map(s => 
      s.id === sceneId ? { ...s, imageFile: file, imagePreview: preview } : s
    ));
  };

  const updateSceneTime = (sceneId: string, field: 'startTime' | 'endTime', value: number) => {
    setScenes(prev => {
      const index = prev.findIndex(s => s.id === sceneId);
      if (index === -1) return prev;

      const newScenes = [...prev];
      newScenes[index] = { ...newScenes[index], [field]: value };

      // Adjust adjacent scenes
      if (field === 'endTime' && index < newScenes.length - 1) {
        newScenes[index + 1] = { ...newScenes[index + 1], startTime: value };
      } else if (field === 'startTime' && index > 0) {
        newScenes[index - 1] = { ...newScenes[index - 1], endTime: value };
      }

      return newScenes;
    });
  };

  const handleCreateProject = async () => {
    if (!title.trim()) {
      toast.error("Please enter a project title");
      return;
    }
    if (!musicFile) {
      toast.error("Please upload a music track");
      return;
    }
    if (scenes.length === 0) {
      toast.error("Please add at least one scene");
      return;
    }

    const scenesWithImages = scenes.filter(s => s.imageFile);
    if (scenesWithImages.length === 0) {
      toast.error("Please add at least one image to your scenes");
      return;
    }

    setUploading(true);
    setUploadProgress(0);

    try {
      // Create project
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .insert({
          title: title.trim(),
          status: "ready",
          user_id: user?.id,
          project_type: "music",
        })
        .select()
        .single();

      if (projectError) throw projectError;
      setUploadProgress(10);

      // Upload music file
      const musicPath = `${project.id}/music.mp3`;
      const { error: musicUploadError } = await supabase.storage
        .from("audio")
        .upload(musicPath, musicFile, { cacheControl: "3600", upsert: true });

      if (musicUploadError) throw musicUploadError;
      setUploadProgress(30);

      const { data: musicUrlData } = supabase.storage.from("audio").getPublicUrl(musicPath);

      // Update project with audio URL and duration
      await supabase
        .from("projects")
        .update({
          audio_url: musicUrlData.publicUrl,
          audio_duration: musicDuration,
        })
        .eq("id", project.id);

      setUploadProgress(40);

      // Upload scene images and create scene records
      for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        let imageUrl = null;

        if (scene.imageFile) {
          const imagePath = `${project.id}/scene_${i + 1}.jpg`;
          const { error: imageUploadError } = await supabase.storage
            .from("images")
            .upload(imagePath, scene.imageFile, { cacheControl: "3600", upsert: true });

          if (imageUploadError) throw imageUploadError;

          const { data: imageUrlData } = supabase.storage.from("images").getPublicUrl(imagePath);
          imageUrl = imageUrlData.publicUrl;
        }

        // Create scene record
        const { error: sceneError } = await supabase
          .from("scenes")
          .insert({
            project_id: project.id,
            scene_number: i + 1,
            scene_type: "image",
            start_time: scene.startTime,
            end_time: scene.endTime,
            narration: "", // No narration for music videos
            visual_prompt: `Music video scene ${i + 1}`,
            image_url: imageUrl,
            transition: "crossfade",
          });

        if (sceneError) throw sceneError;

        setUploadProgress(40 + ((i + 1) / scenes.length) * 50);
      }

      setUploadProgress(100);
      toast.success("Music video project created successfully!");

      // Reset form
      setTitle("");
      setMusicFile(null);
      setMusicDuration(0);
      setScenes([]);
      setUploadProgress(0);

      onProjectCreated(project.id);
    } catch (error: any) {
      console.error("Error creating music video project:", error);
      toast.error(error.message || "Failed to create project");
    } finally {
      setUploading(false);
    }
  };

  const isValid = title.trim() && musicFile && scenes.length > 0 && scenes.some(s => s.imageFile);

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Card className="w-full max-w-3xl bg-card border-border">
        <CardHeader className="text-center">
          <CardTitle className="text-3xl flex items-center justify-center gap-2">
            <Music className="h-8 w-8 text-primary" />
            Create Music Video
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Upload your music track and add images with custom timing
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Project Title */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Project Title</label>
            <Input
              placeholder="Enter project title..."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="bg-background border-border"
              disabled={uploading}
            />
          </div>

          {/* Music Upload */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Music Track</label>
            <div
              className={`relative border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                dragActive
                  ? "border-primary bg-primary/10"
                  : musicFile
                  ? "border-primary/50 bg-primary/5"
                  : "border-border hover:border-primary/50"
              }`}
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
            >
              <input
                type="file"
                accept="audio/*"
                onChange={handleFileSelect}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={uploading}
              />
              <div className="space-y-2">
                {musicFile ? (
                  <>
                    <Music className="h-12 w-12 mx-auto text-primary" />
                    <p className="text-lg font-medium text-foreground">{musicFile.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {formatTime(musicDuration)} • {(musicFile.size / (1024 * 1024)).toFixed(2)} MB
                    </p>
                  </>
                ) : (
                  <>
                    <Upload className="h-12 w-12 mx-auto text-muted-foreground" />
                    <p className="text-lg font-medium text-foreground">
                      Drop your music file here
                    </p>
                    <p className="text-sm text-muted-foreground">
                      MP3, WAV, M4A, OGG supported
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Audio Preview */}
          {musicFile && (
            <div className="flex items-center gap-3 p-3 bg-muted/30 rounded-lg">
              <audio
                ref={audioRef}
                src={URL.createObjectURL(musicFile)}
                onTimeUpdate={handleTimeUpdate}
                onEnded={() => setIsPlaying(false)}
                className="hidden"
              />
              <Button variant="outline" size="icon" onClick={togglePlayPause}>
                {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              </Button>
              <div className="flex-1">
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-primary transition-all"
                    style={{ width: `${(currentTime / musicDuration) * 100}%` }}
                  />
                </div>
              </div>
              <span className="text-sm text-muted-foreground min-w-[80px] text-right">
                {formatTime(currentTime)} / {formatTime(musicDuration)}
              </span>
            </div>
          )}

          {/* Scenes */}
          {musicFile && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-foreground">
                  Scenes ({scenes.length})
                </label>
                <Button variant="outline" size="sm" onClick={addScene}>
                  <Plus className="h-4 w-4 mr-1" />
                  Add Scene
                </Button>
              </div>

              <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2">
                {scenes.map((scene, index) => (
                  <div 
                    key={scene.id} 
                    className="flex gap-3 p-3 bg-muted/30 rounded-lg border border-border"
                  >
                    {/* Image Upload */}
                    <div className="relative w-24 h-24 shrink-0">
                      {scene.imagePreview ? (
                        <img 
                          src={scene.imagePreview} 
                          alt={`Scene ${index + 1}`}
                          className="w-full h-full object-cover rounded-md"
                        />
                      ) : (
                        <label className="flex items-center justify-center w-full h-full bg-muted rounded-md cursor-pointer hover:bg-muted/80 transition-colors">
                          <ImageIcon className="h-8 w-8 text-muted-foreground" />
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                              if (e.target.files?.[0]) {
                                handleSceneImageUpload(scene.id, e.target.files[0]);
                              }
                            }}
                          />
                        </label>
                      )}
                    </div>

                    {/* Scene Details */}
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">Scene {index + 1}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => removeScene(scene.id)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                      <div className="flex gap-2 items-center">
                        <div className="flex-1">
                          <label className="text-xs text-muted-foreground">Start</label>
                          <Input
                            type="number"
                            step="0.1"
                            min="0"
                            max={scene.endTime - 0.1}
                            value={scene.startTime.toFixed(1)}
                            onChange={(e) => updateSceneTime(scene.id, 'startTime', parseFloat(e.target.value) || 0)}
                            className="h-8 text-sm"
                          />
                        </div>
                        <div className="flex-1">
                          <label className="text-xs text-muted-foreground">End</label>
                          <Input
                            type="number"
                            step="0.1"
                            min={scene.startTime + 0.1}
                            max={musicDuration}
                            value={scene.endTime.toFixed(1)}
                            onChange={(e) => updateSceneTime(scene.id, 'endTime', parseFloat(e.target.value) || musicDuration)}
                            className="h-8 text-sm"
                          />
                        </div>
                        <div className="text-sm text-muted-foreground pt-4">
                          {formatTime(scene.endTime - scene.startTime)}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Progress */}
          {uploading && (
            <div className="space-y-2">
              <Progress value={uploadProgress} />
              <p className="text-sm text-center text-muted-foreground">
                Creating project... {Math.round(uploadProgress)}%
              </p>
            </div>
          )}

          {/* Create Button */}
          <Button
            onClick={handleCreateProject}
            disabled={!isValid || uploading}
            className="w-full h-12 text-lg"
          >
            {uploading ? (
              <>
                <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Music className="h-5 w-5 mr-2" />
                Create Music Video Project
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
