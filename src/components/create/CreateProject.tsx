import { useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { 
  Upload, 
  Music, 
  Loader2, 
  FileText, 
  Mic, 
  Scissors, 
  Play, 
  Pause, 
  Download, 
  Check,
  RotateCcw,
  Volume2,
  Zap
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { needsCompression, compressAudio, CompressionProgress } from "@/utils/audioCompression";

interface CreateProjectProps {
  onProjectCreated: (projectId: string) => void;
}

interface ScriptChunk {
  id: number;
  text: string;
  audioUrl?: string;
  status: "pending" | "generating" | "ready" | "error";
}

// Split script into chunks at sentence boundaries, max ~2000 chars
function splitScriptIntoChunks(script: string, maxChars: number = 2000): string[] {
  const chunks: string[] = [];
  const sentences = script.match(/[^.!?]+[.!?]+\s*/g) || [script];
  
  let currentChunk = "";
  
  for (const sentence of sentences) {
    // If adding this sentence would exceed limit, save current chunk and start new one
    if (currentChunk.length + sentence.length > maxChars && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += sentence;
    }
  }
  
  // Add the last chunk if it has content
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

export function CreateProject({ onProjectCreated }: CreateProjectProps) {
  const { user } = useAuth();
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [script, setScript] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStage, setUploadStage] = useState<string>("");
  const [dragActive, setDragActive] = useState(false);
  const [activeTab, setActiveTab] = useState<"audio" | "script">("audio");
  
  // Chunked script state
  const [chunks, setChunks] = useState<ScriptChunk[]>([]);
  const [isScriptSplit, setIsScriptSplit] = useState(false);
  const [playingChunkId, setPlayingChunkId] = useState<number | null>(null);
  const [generatingChunkId, setGeneratingChunkId] = useState<number | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [isDownloading, setIsDownloading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

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
      // Accept any audio file type
      if (droppedFile.type.startsWith("audio/")) {
        setFile(droppedFile);
        if (!title) {
          // Remove extension from filename for title
          const fileName = droppedFile.name;
          const lastDot = fileName.lastIndexOf('.');
          setTitle(lastDot > 0 ? fileName.substring(0, lastDot) : fileName);
        }
      } else {
        toast.error("Please upload an audio file");
      }
    }
  }, [title]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selectedFile = e.target.files[0];
      setFile(selectedFile);
      if (!title) {
        // Remove extension from filename for title
        const fileName = selectedFile.name;
        const lastDot = fileName.lastIndexOf('.');
        setTitle(lastDot > 0 ? fileName.substring(0, lastDot) : fileName);
      }
    }
  };

  const handleSplitScript = () => {
    if (!script.trim()) {
      toast.error("Please enter your script first");
      return;
    }
    
    const splitChunks = splitScriptIntoChunks(script.trim());
    const chunkObjects: ScriptChunk[] = splitChunks.map((text, index) => ({
      id: index + 1,
      text,
      status: "pending"
    }));
    
    setChunks(chunkObjects);
    setIsScriptSplit(true);
    toast.success(`Script split into ${chunkObjects.length} chunks`);
  };

  const handleResetSplit = () => {
    setChunks([]);
    setIsScriptSplit(false);
    setPlayingChunkId(null);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  };

  const handlePreviewChunk = async (chunk: ScriptChunk) => {
    // If already playing this chunk, stop it
    if (playingChunkId === chunk.id && audioRef.current) {
      audioRef.current.pause();
      setPlayingChunkId(null);
      return;
    }

    // If chunk already has audio, play it
    if (chunk.audioUrl) {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      audioRef.current = new Audio(chunk.audioUrl);
      audioRef.current.onended = () => setPlayingChunkId(null);
      audioRef.current.play();
      setPlayingChunkId(chunk.id);
      return;
    }

    // Generate audio for this chunk
    setGeneratingChunkId(chunk.id);
    setChunks(prev => prev.map(c => 
      c.id === chunk.id ? { ...c, status: "generating" } : c
    ));

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-tts-chunk`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
            "Authorization": `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({
            text: chunk.text,
            voice: "onyx",
            chunkId: `preview_${chunk.id}`,
          }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to generate audio");
      }

      // Now returns JSON with audioUrl instead of binary
      const { audioUrl } = await response.json();
      
      setChunks(prev => prev.map(c => 
        c.id === chunk.id ? { ...c, audioUrl, status: "ready" } : c
      ));

      // Play the generated audio
      if (audioRef.current) {
        audioRef.current.pause();
      }
      audioRef.current = new Audio(audioUrl);
      audioRef.current.onended = () => setPlayingChunkId(null);
      audioRef.current.play();
      setPlayingChunkId(chunk.id);

    } catch (error: any) {
      console.error("Error generating chunk audio:", error);
      toast.error(`Failed to generate audio for chunk ${chunk.id}: ${error.message}`);
      setChunks(prev => prev.map(c => 
        c.id === chunk.id ? { ...c, status: "error" } : c
      ));
    } finally {
      setGeneratingChunkId(null);
    }
  };

  const handleDownloadFullAudio = async () => {
    if (!title.trim()) {
      toast.error("Please enter a project title");
      return;
    }

    setIsDownloading(true);
    setDownloadProgress(0);

    try {
      // Create project first
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .insert({ title: title.trim(), status: "processing", user_id: user?.id, progress: 0 })
        .select()
        .single();
      if (projectError) throw projectError;

      toast.info("Generating full audio... This may take a few minutes.");

      // Generate audio for each chunk sequentially and collect URLs
      const audioUrls: string[] = [];
      
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const progress = Math.round(((i + 1) / chunks.length) * 70);
        setDownloadProgress(progress);

        // Update project progress
        await supabase
          .from("projects")
          .update({ progress })
          .eq("id", project.id);

        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-tts-chunk`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
              "Authorization": `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
            },
            body: JSON.stringify({
              text: chunk.text,
              voice: "onyx",
              chunkId: `${project.id}_chunk_${i}`,
            }),
          }
        );

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `Failed to generate audio for chunk ${i + 1}`);
        }

        const { audioUrl } = await response.json();
        audioUrls.push(audioUrl);
      }

      setDownloadProgress(75);

      // Download and combine all audio chunks
      const audioBlobs: Blob[] = [];
      for (const url of audioUrls) {
        const res = await fetch(url);
        audioBlobs.push(await res.blob());
      }
      const combinedBlob = new Blob(audioBlobs, { type: "audio/mpeg" });
      
      // Upload combined audio to storage
      const filePath = `${project.id}/audio.mp3`;
      const { error: uploadError } = await supabase.storage
        .from("audio")
        .upload(filePath, combinedBlob, {
          cacheControl: "3600",
          upsert: true,
        });

      if (uploadError) throw uploadError;

      setDownloadProgress(85);

      // Get public URL
      const { data: urlData } = supabase.storage.from("audio").getPublicUrl(filePath);

      // Update project with audio URL and transcript
      const { error: updateError } = await supabase
        .from("projects")
        .update({ 
          audio_url: urlData.publicUrl,
          transcript: script.trim(),
          status: "ready",
          progress: 100
        })
        .eq("id", project.id);

      if (updateError) throw updateError;

      setDownloadProgress(100);
      toast.success("Project created successfully!");
      
      // Reset form
      setTitle("");
      setScript("");
      setChunks([]);
      setIsScriptSplit(false);
      setDownloadProgress(0);
      
      // Navigate to projects tab
      onProjectCreated(project.id);

    } catch (error: any) {
      console.error("Error creating project:", error);
      toast.error(error.message || "Failed to create project");
    } finally {
      setIsDownloading(false);
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
    setUploadStage("");

    try {
      // Create project first (include user_id for RLS)
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .insert({ title: title.trim(), status: "draft", user_id: user?.id })
        .select()
        .single();
      if (projectError) throw projectError;

      setUploadProgress(10);

      // Check if compression is needed
      let fileToUpload: Blob = file;
      let fileExt = file.name.split(".").pop() || "mp3";
      
      if (needsCompression(file)) {
        const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
        setUploadStage(`Compressing audio (${fileSizeMB}MB)...`);
        toast.info(`Large audio file detected (${fileSizeMB}MB). Compressing for transcription...`);
        
        try {
          const result = await compressAudio(file, (progress: CompressionProgress) => {
            // Map compression progress to 10-50% of total progress
            const baseProgress = 10;
            const compressionRange = 40;
            
            if (progress.stage === 'decoding') {
              setUploadProgress(baseProgress + (progress.progress / 100) * (compressionRange / 2));
              setUploadStage("Decoding audio...");
            } else if (progress.stage === 'encoding') {
              setUploadProgress(baseProgress + (compressionRange / 2) + (progress.progress / 100) * (compressionRange / 2));
              setUploadStage("Encoding compressed audio...");
            }
          });
          
          fileToUpload = result.blob;
          fileExt = "wav"; // Compressed output is WAV
          
          const originalMB = (result.originalSize / (1024 * 1024)).toFixed(1);
          const compressedMB = (result.compressedSize / (1024 * 1024)).toFixed(1);
          toast.success(`Compressed ${originalMB}MB → ${compressedMB}MB (${result.compressionRatio.toFixed(1)}x smaller)`);
        } catch (compressionError: any) {
          console.error("Compression error:", compressionError);
          toast.error(compressionError.message || "Failed to compress audio");
          throw compressionError;
        }
      }

      setUploadProgress(50);
      setUploadStage("Uploading audio...");

      // Upload audio file (original or compressed)
      const filePath = `${project.id}/audio.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from("audio")
        .upload(filePath, fileToUpload, {
          cacheControl: "3600",
          upsert: true,
        });

      if (uploadError) throw uploadError;

      setUploadProgress(85);
      setUploadStage("Finalizing...");

      // Get public URL
      const { data: urlData } = supabase.storage.from("audio").getPublicUrl(filePath);

      // Update project with audio URL
      const { error: updateError } = await supabase
        .from("projects")
        .update({ audio_url: urlData.publicUrl })
        .eq("id", project.id);

      if (updateError) throw updateError;

      setUploadProgress(100);
      setUploadStage("");
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
      setUploadStage("");
    }
  };

  const allChunksReady = chunks.length > 0 && chunks.every(c => c.status === "ready");
  const isValid = title.trim() && (activeTab === "audio" ? file : (isScriptSplit ? chunks.length > 0 : script.trim()));

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
              disabled={uploading || isDownloading}
            />
          </div>

          {/* Tabs for Audio vs Script */}
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "audio" | "script")}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="audio" disabled={uploading || isDownloading} className="flex items-center gap-2">
                <Music className="h-4 w-4" />
                Upload Audio
              </TabsTrigger>
              <TabsTrigger value="script" disabled={uploading || isDownloading} className="flex items-center gap-2">
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
                  accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac"
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
                        {needsCompression(file) && (
                          <div className="flex items-center justify-center gap-1 mt-2 text-xs text-amber-500">
                            <Zap className="h-3 w-3" />
                            <span>Will be compressed for transcription</span>
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <Upload className="h-16 w-16 mx-auto text-muted-foreground" />
                      <div>
                        <p className="text-lg font-medium text-foreground">
                          Drag & drop your audio file here
                        </p>
                        <p className="text-sm text-muted-foreground">
                          MP3, WAV, or other audio formats
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Large files (&gt;20MB) will be compressed automatically
                        </p>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="script" className="mt-4 space-y-4">
              {!isScriptSplit ? (
                <>
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
                      placeholder="Paste your narration script here... We'll split it into chunks for preview."
                      value={script}
                      onChange={(e) => setScript(e.target.value)}
                      className="bg-background border-border min-h-[200px] resize-y"
                      disabled={uploading}
                    />
                    <p className="text-xs text-muted-foreground">
                      Estimated cost: ~${((script.length / 1000000) * 15).toFixed(2)} for {script.length.toLocaleString()} characters.
                    </p>
                  </div>

                  {/* Split Script Button */}
                  <Button
                    onClick={handleSplitScript}
                    disabled={!script.trim()}
                    variant="outline"
                    className="w-full"
                  >
                    <Scissors className="h-4 w-4 mr-2" />
                    Split Script into Chunks
                  </Button>
                </>
              ) : (
                <>
                  {/* Chunk List */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium text-foreground">
                        Script Chunks ({chunks.length} total)
                      </label>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleResetSplit}
                        disabled={isDownloading}
                      >
                        <RotateCcw className="h-4 w-4 mr-1" />
                        Reset
                      </Button>
                    </div>
                    
                    <ScrollArea className="h-[300px] border border-border rounded-lg">
                      <div className="p-2 space-y-2">
                        {chunks.map((chunk) => (
                          <div 
                            key={chunk.id}
                            className="flex items-start gap-3 p-3 bg-muted/30 rounded-lg hover:bg-muted/50 transition-colors"
                          >
                            <div className="flex-shrink-0 pt-0.5">
                              <Badge variant="outline" className="font-mono text-xs">
                                {chunk.id}
                              </Badge>
                            </div>
                            
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-foreground line-clamp-2">
                                {chunk.text}
                              </p>
                              <p className="text-xs text-muted-foreground mt-1">
                                {chunk.text.length.toLocaleString()} chars
                              </p>
                            </div>
                            
                            <div className="flex-shrink-0 flex items-center gap-2">
                              {chunk.status === "ready" && (
                                <Check className="h-4 w-4 text-green-500" />
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handlePreviewChunk(chunk)}
                                disabled={generatingChunkId !== null && generatingChunkId !== chunk.id}
                                className="h-8 w-8 p-0"
                              >
                                {generatingChunkId === chunk.id ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : playingChunkId === chunk.id ? (
                                  <Pause className="h-4 w-4" />
                                ) : chunk.status === "ready" ? (
                                  <Volume2 className="h-4 w-4" />
                                ) : (
                                  <Play className="h-4 w-4" />
                                )}
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>

                    <p className="text-xs text-muted-foreground text-center">
                      Click play on each chunk to preview. Green check = tested and ready.
                    </p>
                  </div>

                  {/* Download Progress */}
                  {isDownloading && (
                    <div className="space-y-2">
                      <Progress value={downloadProgress} className="h-2" />
                      <p className="text-sm text-center text-muted-foreground">
                        Generating full audio... {downloadProgress}%
                      </p>
                    </div>
                  )}

                  {/* Download Full Audio Button */}
                  <Button
                    onClick={handleDownloadFullAudio}
                    disabled={!title.trim() || isDownloading || chunks.length === 0}
                    className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
                    size="lg"
                  >
                    {isDownloading ? (
                      <>
                        <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                        Generating Audio...
                      </>
                    ) : (
                      <>
                        <Download className="h-5 w-5 mr-2" />
                        Create Project with Full Audio
                      </>
                    )}
                  </Button>
                </>
              )}
            </TabsContent>
          </Tabs>

          {/* Upload Progress (for audio tab) */}
          {uploading && activeTab === "audio" && (
            <div className="space-y-2">
              <Progress value={uploadProgress} className="h-2" />
              <p className="text-sm text-center text-muted-foreground">
                {uploadStage || `Uploading... ${uploadProgress}%`}
                {uploadStage && ` (${uploadProgress}%)`}
              </p>
            </div>
          )}

          {/* Create Button (for audio tab only) */}
          {activeTab === "audio" && (
            <Button
              onClick={handleCreateWithAudio}
              disabled={!isValid || uploading}
              className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
              size="lg"
            >
              {uploading ? (
                <>
                  <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                  Creating Project...
                </>
              ) : (
                "Create Project"
              )}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
