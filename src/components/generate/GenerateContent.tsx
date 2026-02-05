import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sparkles, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";

interface GenerateContentProps {
  onProjectCreated: (projectId: string) => void;
}

export function GenerateContent({ onProjectCreated }: GenerateContentProps) {
  const { user } = useAuth();
  const [topic, setTopic] = useState("");
  const [style, setStyle] = useState("documentary");
  const [videoLength, setVideoLength] = useState("60");
  const [generateShorts, setGenerateShorts] = useState(false);
  const [shortsCount, setShortsCount] = useState(2);
  const [shortsLength, setShortsLength] = useState("30");
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");

  const handleGenerate = async () => {
    if (!topic.trim()) {
      toast.error("Please enter a topic");
      return;
    }

    setGenerating(true);
    setProgress(10);
    setProgressMessage("Generating main video script with Claude AI...");

    try {
      const { data, error } = await supabase.functions.invoke(
        "generate-content",
        {
          body: {
            topic: topic.trim(),
            style,
            videoLength: parseInt(videoLength),
            generateShorts,
            shortsCount: generateShorts ? shortsCount : 0,
            shortsLength: generateShorts ? parseInt(shortsLength) : 0,
            userId: user?.id,
          },
        },
      );

      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Generation failed");

      setProgress(100);
      setProgressMessage("Done!");

      const projectWord = data.projectCount === 1 ? "project" : "projects";
      toast.success(
        `Created ${data.projectCount} ${projectWord} successfully!`,
      );

      // Reset form
      setTopic("");
      setGenerateShorts(false);
      setShortsCount(2);
      setProgress(0);
      setProgressMessage("");

      // Navigate to the main project
      onProjectCreated(data.mainProjectId);
    } catch (error: any) {
      console.error("Error generating content:", error);
      toast.error(error.message || "Failed to generate content");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Card className="w-full max-w-2xl bg-card border-border">
        <CardHeader className="text-center">
          <CardTitle className="text-3xl flex items-center justify-center gap-3">
            <Sparkles className="h-8 w-8" />
            Generate Content
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Use AI to generate video scripts with scenes automatically
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Topic */}
          <div className="space-y-2">
            <Label htmlFor="topic">Topic</Label>
            <Input
              id="topic"
              placeholder="e.g. The History of Ancient Rome"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              className="bg-background border-border"
              disabled={generating}
            />
          </div>

          {/* Style / Tone */}
          <div className="space-y-2">
            <Label>Style / Tone</Label>
            <Select
              value={style}
              onValueChange={setStyle}
              disabled={generating}
            >
              <SelectTrigger className="bg-background border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="documentary">Documentary</SelectItem>
                <SelectItem value="educational">Educational</SelectItem>
                <SelectItem value="entertainment">Entertainment</SelectItem>
                <SelectItem value="promotional">Promotional</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Video Length */}
          <div className="space-y-2">
            <Label>Main Video Length</Label>
            <Select
              value={videoLength}
              onValueChange={setVideoLength}
              disabled={generating}
            >
              <SelectTrigger className="bg-background border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="60">1 minute</SelectItem>
                <SelectItem value="120">2 minutes</SelectItem>
                <SelectItem value="180">3 minutes</SelectItem>
                <SelectItem value="300">5 minutes</SelectItem>
                <SelectItem value="600">10 minutes</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Generate Shorts */}
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Checkbox
                id="generate-shorts"
                checked={generateShorts}
                onCheckedChange={(checked) =>
                  setGenerateShorts(checked === true)
                }
                disabled={generating}
              />
              <Label htmlFor="generate-shorts" className="cursor-pointer">
                Generate teaser shorts
              </Label>
            </div>

            {generateShorts && (
              <div className="ml-7 space-y-4 border-l-2 border-border pl-4">
                {/* Number of shorts */}
                <div className="space-y-2">
                  <Label htmlFor="shorts-count">Number of shorts</Label>
                  <Input
                    id="shorts-count"
                    type="number"
                    min={1}
                    max={5}
                    value={shortsCount}
                    onChange={(e) => {
                      const val = parseInt(e.target.value) || 1;
                      setShortsCount(Math.min(5, Math.max(1, val)));
                    }}
                    className="bg-background border-border w-24"
                    disabled={generating}
                  />
                </div>

                {/* Shorts length */}
                <div className="space-y-2">
                  <Label>Shorts length</Label>
                  <Select
                    value={shortsLength}
                    onValueChange={setShortsLength}
                    disabled={generating}
                  >
                    <SelectTrigger className="bg-background border-border w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="30">30 seconds</SelectItem>
                      <SelectItem value="45">45 seconds</SelectItem>
                      <SelectItem value="60">60 seconds</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </div>

          {/* Progress */}
          {generating && (
            <div className="space-y-2">
              <Progress value={progress} className="h-2" />
              <p className="text-sm text-center text-muted-foreground">
                {progressMessage}
              </p>
            </div>
          )}

          {/* Generate Button */}
          <Button
            onClick={handleGenerate}
            disabled={!topic.trim() || generating}
            className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
            size="lg"
          >
            {generating ? (
              <>
                <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="h-5 w-5 mr-2" />
                Generate Script
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
