import { useEffect, useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Render } from "@/types/project";

interface VideoPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  render: Render | null;
  title?: string;
}

export function VideoPreviewDialog({ open, onOpenChange, render, title }: VideoPreviewDialogProps) {
  const vttUrl = useMemo(() => {
    if (!render?.subtitle_vtt) return null;
    const blob = new Blob([render.subtitle_vtt], { type: "text/vtt;charset=utf-8" });
    return URL.createObjectURL(blob);
  }, [render?.subtitle_vtt]);

  useEffect(() => {
    return () => {
      if (vttUrl) URL.revokeObjectURL(vttUrl);
    };
  }, [vttUrl]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{title || "Video preview"}</DialogTitle>
        </DialogHeader>

        {render?.video_url ? (
          <div className="space-y-2">
            <video className="w-full rounded-md" controls src={render.video_url}>
              {vttUrl ? (
                <track
                  default
                  kind="subtitles"
                  srcLang="en"
                  label="Subtitles"
                  src={vttUrl}
                />
              ) : null}
            </video>
            <p className="text-sm text-muted-foreground">
              Tip: If subtitles don’t appear, use the CC/subtitles control in your player.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No video URL available for this render.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
