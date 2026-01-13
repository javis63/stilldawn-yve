import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Upload, Music, Loader2, FileText, Mic } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";

interface CreateProjectProps {
  onProjectCreated: (projectId: string) => void;
}

export function CreateProject({ onProjectCreated }: CreateProjectProps) {
  const { user } = useAuth();
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [script, setScript] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [activeTab, setActiveTab] = useState<"audio" | "script">("audio");

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
      if (droppedFile.type === "audio/mpeg" || droppedFile.name.endsWith(".mp3")) {
        setFile(droppedFile);
        if (!title) {
          setTitle(droppedFile.name.replace(".mp3", ""));
        }
      } else {
        toast.error("Please upload an MP3 file");
      }
    }
  }, [title]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selectedFile = e.target.files[0];
      setFile(selectedFile);
      if (!title) {
        setTitle(selectedFile.name.replace(".mp3", ""));
      }
    }
  };

  const handleCreateWithAudio = async () => {
    if (!title.trim()) {
      toast.error("Please enter a project title");
      return;
    }
    if (!file) {
      toast.error("Please upload an MP3 file");
      return;
    }

    setUploading(true);
    setUploadProgress(0);

    try {
      // Create project first (include user_id for RLS)
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .insert({ title: title.trim(), status: "draft", user_id: user?.id })
        .select()
        .single();
      if (projectError) throw projectError;

      setUploadProgress(20);

      // Upload audio file
      const fileExt = file.name.split(".").pop();
      const filePath = `${project.id}/audio.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from("audio")
        .upload(filePath, file, {
          cacheControl: "3600",
          upsert: true,
        });

      if (uploadError) throw uploadError;

      setUploadProgress(80);

      // Get public URL
      const { data: urlData } = supabase.storage.from("audio").getPublicUrl(filePath);

      // Update project with audio URL
      const { error: updateError } = await supabase
        .from("projects")
        .update({ audio_url: urlData.publicUrl })
        .eq("id", project.id);

      if (updateError) throw updateError;

      setUploadProgress(100);
      toast.success("Project created successfully!");
      
      // Reset form
      setTitle("");
      setFile(null);
      setUploadProgress(0);
      
      // Navigate to projects tab
      onProjectCreated(project.id);
    } catch (error: any) {
      console.error("Error creating project:", error);
      toast.error(error.message || "Failed to create project");
    } finally {
      setUploading(false);
    }
  };

  const handleCreateWithScript = async () => {
    if (!title.trim()) {
      toast.error("Please enter a project title");
      return;
    }
    if (!script.trim()) {
      toast.error("Please enter your script");
      return;
    }

    setUploading(true);
    setUploadProgress(0);

    try {
      // Create project first
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .insert({ title: title.trim(), status: "draft", user_id: user?.id })
        .select()
        .single();
      if (projectError) throw projectError;

      setUploadProgress(10);
      toast.info("Generating audio from script... This may take a few minutes for long scripts.");

      // Call TTS edge function
      const { data: ttsData, error: ttsError } = await supabase.functions.invoke("generate-tts", {
        body: {
          projectId: project.id,
          script: script.trim(),
          voice: "onyx", // Natural-sounding male voice
        },
      });

      if (ttsError) throw ttsError;
      if (!ttsData.success) throw new Error(ttsData.error || "TTS generation failed");

      setUploadProgress(100);
      toast.success("Project created with generated audio!");
      
      // Reset form
      setTitle("");
      setScript("");
      setUploadProgress(0);
      
      // Navigate to projects tab
      onProjectCreated(project.id);
    } catch (error: any) {
      console.error("Error creating project:", error);
      toast.error(error.message || "Failed to create project");
    } finally {
      setUploading(false);
    }
  };

  const handleCreate = () => {
    if (activeTab === "audio") {
      handleCreateWithAudio();
    } else {
      handleCreateWithScript();
    }
  };

  const isValid = title.trim() && (activeTab === "audio" ? file : script.trim());

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Card className="w-full max-w-2xl bg-card border-border">
        <CardHeader className="text-center">
          <CardTitle className="text-3xl">Create New Project</CardTitle>
          <CardDescription className="text-muted-foreground">
            Upload your MP3 narration or paste your script
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

          {/* Tabs for Audio vs Script */}
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "audio" | "script")}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="audio" disabled={uploading} className="flex items-center gap-2">
                <Music className="h-4 w-4" />
                Upload Audio
              </TabsTrigger>
              <TabsTrigger value="script" disabled={uploading} className="flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Paste Script
              </TabsTrigger>
            </TabsList>

            <TabsContent value="audio" className="mt-4">
              {/* Upload Zone */}
              <div
                className={`relative border-2 border-dashed rounded-lg p-12 text-center transition-colors ${
                  dragActive
                    ? "border-primary bg-primary/10"
                    : file
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
                  accept=".mp3,audio/mpeg"
                  onChange={handleFileSelect}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  disabled={uploading}
                />
                <div className="space-y-4">
                  {file ? (
                    <>
                      <Music className="h-16 w-16 mx-auto text-primary" />
                      <div>
                        <p className="text-lg font-medium text-foreground">{file.name}</p>
                        <p className="text-sm text-muted-foreground">
                          {(file.size / (1024 * 1024)).toFixed(2)} MB
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <Upload className="h-16 w-16 mx-auto text-muted-foreground" />
                      <div>
                        <p className="text-lg font-medium text-foreground">
                          Drag & drop your MP3 file here
                        </p>
                        <p className="text-sm text-muted-foreground">
                          or click to browse (25-80MB supported)
                        </p>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="script" className="mt-4 space-y-4">
              {/* Script Input */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-foreground flex items-center gap-2">
                    <Mic className="h-4 w-4" />
                    Your Script
                  </label>
                  <span className="text-xs text-muted-foreground">
                    {script.length.toLocaleString()} characters
                  </span>
                </div>
                <Textarea
                  placeholder="Paste your narration script here... We'll generate natural-sounding audio using OpenAI TTS."
                  value={script}
                  onChange={(e) => setScript(e.target.value)}
                  className="bg-background border-border min-h-[200px] resize-y"
                  disabled={uploading}
                />
                <p className="text-xs text-muted-foreground">
                  Audio will be generated using OpenAI TTS-1 with a natural voice. 
                  Estimated cost: ~${((script.length / 1000000) * 15).toFixed(2)} for {script.length.toLocaleString()} characters.
                </p>
              </div>
            </TabsContent>
          </Tabs>

          {/* Upload Progress */}
          {uploading && (
            <div className="space-y-2">
              <Progress value={uploadProgress} className="h-2" />
              <p className="text-sm text-center text-muted-foreground">
                {activeTab === "script" 
                  ? "Generating audio & timestamps..."
                  : "Uploading..."
                } {uploadProgress}%
              </p>
            </div>
          )}

          {/* Create Button */}
          <Button
            onClick={handleCreate}
            disabled={!isValid || uploading}
            className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
            size="lg"
          >
            {uploading ? (
              <>
                <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                {activeTab === "script" ? "Generating Audio..." : "Creating Project..."}
              </>
            ) : (
              "Create Project"
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
