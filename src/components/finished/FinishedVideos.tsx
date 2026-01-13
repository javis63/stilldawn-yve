import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Copy,
  Check,
  Video,
  FileText,
  Hash,
  RefreshCw,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Render } from "@/types/project";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

function formatDuration(seconds: number | null): string {
  if (!seconds) return "--:--";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function FinishedVideos() {
  const [renders, setRenders] = useState<Render[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const fetchRenders = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("renders")
        .select(`
          *,
          project:projects(title)
        `)
        .order("created_at", { ascending: false });

      if (error) throw error;
      setRenders((data || []) as any);
    } catch (error) {
      console.error("Error fetching renders:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRenders();
  }, []);

  const toggleRow = (id: string) => {
    setExpandedRows((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const handleCopy = async (text: string, fieldId: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedField(fieldId);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopiedField(null), 2000);
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      queued: "secondary",
      rendering: "outline",
      completed: "default",
      failed: "destructive",
    };
    const colors: Record<string, string> = {
      queued: "",
      rendering: "text-yellow-400 border-yellow-400",
      completed: "bg-green-600",
      failed: "",
    };
    return (
      <Badge variant={variants[status]} className={`capitalize ${colors[status]}`}>
        {status === "rendering" && <RefreshCw className="h-3 w-3 mr-1 animate-spin" />}
        {status}
      </Badge>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (renders.length === 0) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="flex flex-col items-center justify-center py-20 text-center">
          <Video className="h-20 w-20 text-muted-foreground mb-4" />
          <h3 className="text-xl font-medium text-foreground mb-2">No Finished Videos</h3>
          <p className="text-muted-foreground max-w-sm">
            Rendered videos will appear here with download links and YouTube SEO metadata.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card border-border">
      <Table>
        <TableHeader>
          <TableRow className="border-border hover:bg-transparent">
            <TableHead className="w-8"></TableHead>
            <TableHead className="w-24">Preview</TableHead>
            <TableHead>Title</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {renders.map((render) => (
            <Collapsible key={render.id} open={expandedRows.has(render.id)} asChild>
              <>
                <TableRow className="border-border">
                  <TableCell>
                    <CollapsibleTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => toggleRow(render.id)}
                      >
                        {expandedRows.has(render.id) ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </Button>
                    </CollapsibleTrigger>
                  </TableCell>
                  <TableCell>
                    {render.thumbnail_url ? (
                      <div className="w-20 h-12 rounded overflow-hidden">
                        <img
                          src={render.thumbnail_url}
                          alt="Thumbnail"
                          className="w-full h-full object-cover"
                        />
                      </div>
                    ) : (
                      <div className="w-20 h-12 rounded bg-muted flex items-center justify-center">
                        <Video className="h-5 w-5 text-muted-foreground" />
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="font-medium">
                    {(render.project as any)?.title || "Untitled"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDistanceToNow(new Date(render.created_at), { addSuffix: true })}
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">
                    {formatDuration(render.duration)}
                  </TableCell>
                  <TableCell>{getStatusBadge(render.status)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!render.video_url}
                      asChild
                    >
                      <a href={render.video_url || "#"} download>
                        <Download className="h-4 w-4 mr-1" />
                        Download
                      </a>
                    </Button>
                  </TableCell>
                </TableRow>

                <CollapsibleContent asChild>
                  <TableRow className="border-border bg-muted/30">
                    <TableCell colSpan={7} className="p-6">
                      <div className="grid grid-cols-2 gap-6">
                        {/* Subtitles Section */}
                        <div className="space-y-3">
                          <h4 className="font-semibold flex items-center gap-2">
                            <FileText className="h-4 w-4 text-primary" />
                            Subtitles
                          </h4>
                          <div className="flex gap-3">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={!render.subtitle_srt}
                              asChild
                            >
                              <a
                                href={render.subtitle_srt ? `data:text/plain;charset=utf-8,${encodeURIComponent(render.subtitle_srt)}` : "#"}
                                download="subtitles.srt"
                              >
                                <Download className="h-4 w-4 mr-1" />
                                Download SRT
                              </a>
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={!render.subtitle_vtt}
                              asChild
                            >
                              <a
                                href={render.subtitle_vtt ? `data:text/plain;charset=utf-8,${encodeURIComponent(render.subtitle_vtt)}` : "#"}
                                download="subtitles.vtt"
                              >
                                <Download className="h-4 w-4 mr-1" />
                                Download VTT
                              </a>
                            </Button>
                          </div>
                        </div>

                        {/* SEO Section */}
                        <div className="space-y-3">
                          <h4 className="font-semibold flex items-center gap-2">
                            <Hash className="h-4 w-4 text-primary" />
                            YouTube SEO
                          </h4>
                          <div className="space-y-3">
                            {/* Title */}
                            <div className="space-y-1">
                              <label className="text-xs text-muted-foreground">Title</label>
                              <div className="flex items-center gap-2">
                                <p className="text-sm bg-background rounded px-3 py-2 flex-1 border border-border">
                                  {render.seo_title || "Not generated yet"}
                                </p>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  disabled={!render.seo_title}
                                  onClick={() => handleCopy(render.seo_title!, `title-${render.id}`)}
                                >
                                  {copiedField === `title-${render.id}` ? (
                                    <Check className="h-4 w-4 text-green-400" />
                                  ) : (
                                    <Copy className="h-4 w-4" />
                                  )}
                                </Button>
                              </div>
                            </div>

                            {/* Description */}
                            <div className="space-y-1">
                              <label className="text-xs text-muted-foreground">Description</label>
                              <div className="flex items-start gap-2">
                                <p className="text-sm bg-background rounded px-3 py-2 flex-1 border border-border max-h-20 overflow-y-auto">
                                  {render.seo_description || "Not generated yet"}
                                </p>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  disabled={!render.seo_description}
                                  onClick={() => handleCopy(render.seo_description!, `desc-${render.id}`)}
                                >
                                  {copiedField === `desc-${render.id}` ? (
                                    <Check className="h-4 w-4 text-green-400" />
                                  ) : (
                                    <Copy className="h-4 w-4" />
                                  )}
                                </Button>
                              </div>
                            </div>

                            {/* Keywords */}
                            <div className="space-y-1">
                              <label className="text-xs text-muted-foreground">Keywords</label>
                              <div className="flex items-center gap-2">
                                <p className="text-sm bg-background rounded px-3 py-2 flex-1 border border-border truncate">
                                  {render.seo_keywords || "Not generated yet"}
                                </p>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  disabled={!render.seo_keywords}
                                  onClick={() => handleCopy(render.seo_keywords!, `kw-${render.id}`)}
                                >
                                  {copiedField === `kw-${render.id}` ? (
                                    <Check className="h-4 w-4 text-green-400" />
                                  ) : (
                                    <Copy className="h-4 w-4" />
                                  )}
                                </Button>
                              </div>
                            </div>

                            {/* Hashtags */}
                            <div className="space-y-1">
                              <label className="text-xs text-muted-foreground">Hashtags</label>
                              <div className="flex items-center gap-2">
                                <p className="text-sm bg-background rounded px-3 py-2 flex-1 border border-border truncate">
                                  {render.seo_hashtags || "Not generated yet"}
                                </p>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  disabled={!render.seo_hashtags}
                                  onClick={() => handleCopy(render.seo_hashtags!, `hash-${render.id}`)}
                                >
                                  {copiedField === `hash-${render.id}` ? (
                                    <Check className="h-4 w-4 text-green-400" />
                                  ) : (
                                    <Copy className="h-4 w-4" />
                                  )}
                                </Button>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                </CollapsibleContent>
              </>
            </Collapsible>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
