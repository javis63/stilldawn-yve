import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Render } from "@/types/project";

interface VideoPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  render: Render | null;
  title?: string;
}

export function VideoPreviewDialog({ open, onOpenChange, render, title }: VideoPreviewDialogProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [caption, setCaption] = useState<string>("");

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

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !vttUrl) return;

    // Wait until tracks are attached
    const attach = () => {
      const track = video.textTracks?.[0];
      if (!track) return;

      // Hide native captions and render our own so we can control styling.
      track.mode = "hidden";

      const update = () => {
        const active = track.activeCues;
        const text = active && active.length ? (active[0] as any).text || "" : "";
        setCaption(text);
      };

      // Some browsers don't support addEventListener on TextTrack
      try {
        track.addEventListener("cuechange", update);
      } catch {
        // ignore
      }

      update();

      return () => {
        try {
          track.removeEventListener("cuechange", update);
        } catch {
          // ignore
        }
      };
    };

    // Attempt immediately and again shortly after (track loading can be async)
    const cleanup = attach();
    const t = window.setTimeout(() => attach(), 250);

    return () => {
      window.clearTimeout(t);
      if (typeof cleanup === "function") cleanup();
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
            <div className="relative">
              <video ref={videoRef} className="w-full rounded-md" controls src={render.video_url}>
                {vttUrl ? <track default kind="subtitles" srcLang="en" label="Subtitles" src={vttUrl} /> : null}
              </video>

              {caption ? (
                <div className="pointer-events-none absolute bottom-3 left-1/2 w-[min(92%,_920px)] -translate-x-1/2 text-center">
                  <div className="inline-block rounded-md bg-background/30 px-3 py-2 backdrop-blur-sm">
                    <p className="text-caption caption-outline text-base md:text-lg leading-snug whitespace-pre-wrap">
                      {caption}
                    </p>
                  </div>
                </div>
              ) : null}
            </div>

            <p className="text-sm text-muted-foreground">Tip: Press play for a second so the subtitle track loads.</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No video URL available for this render.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
