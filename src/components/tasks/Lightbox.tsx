"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ChevronLeft, ChevronRight, Download, Volume2, VolumeX, Sparkles } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { ImageResizePanel } from "@/components/tasks/ImageResizePanel";
import { ImageEditor } from "@/components/tasks/ImageEditor";

interface LightboxProps {
  images: string[];
  index: number;
  modelId?: string;
  prompt?: string;
  mediaType?: "image" | "video";
  sourceTaskId?: string;
  onClose: () => void;
  onNext: () => void;
  onPrev: () => void;
}

export function Lightbox({ images, index, modelId, prompt, mediaType = "image", sourceTaskId, onClose, onNext, onPrev }: LightboxProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (editing) return;
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") onNext();
      if (e.key === "ArrowLeft") onPrev();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, onNext, onPrev, editing]);

  const isVideo = mediaType === "video";

  if (!isVideo) return <>
    <AnimatePresence>
      <motion.div
        key="image-lightbox"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        role="dialog"
        aria-modal="true"
        aria-label="Vista de imagen y formatos"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-2 backdrop-blur-sm sm:p-4"
        onClick={onClose}
      >
        <div
          className="flex max-h-[96dvh] w-full max-w-[1580px] flex-col overflow-y-auto rounded-2xl border border-white/10 bg-[#101010] shadow-2xl lg:h-[92dvh] lg:flex-row lg:overflow-hidden"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="relative flex h-[42dvh] min-h-[280px] min-w-0 flex-1 items-center justify-center overflow-hidden bg-black p-4 lg:h-full lg:min-h-0 lg:p-8">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={images[index]} alt={`Imagen ${index + 1} de ${images.length}`} className="max-h-full max-w-full rounded-lg object-contain" />
            {images.length > 1 && <>
              <button type="button" aria-label="Imagen anterior" onClick={onPrev} className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-black/70 p-2 text-white hover:bg-white/20"><ChevronLeft className="h-5 w-5" /></button>
              <button type="button" aria-label="Imagen siguiente" onClick={onNext} className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-black/70 p-2 text-white hover:bg-white/20"><ChevronRight className="h-5 w-5" /></button>
              <div className="absolute bottom-3 rounded-full bg-black/70 px-3 py-1 text-xs text-white/70">{index + 1} / {images.length}</div>
            </>}
          </div>
          <aside className="w-full shrink-0 border-t border-white/10 bg-[#121212] lg:w-[390px] lg:overflow-y-auto lg:border-l lg:border-t-0 xl:w-[430px]">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/10 bg-[#121212] px-5 py-3">
              <p className="text-sm font-bold text-white">Detalles de la imagen</p>
              <div className="flex items-center gap-1">
                <a href={sourceTaskId ? `/api/download/${encodeURIComponent(sourceTaskId)}?index=${index}` : images[index]} download aria-label="Descargar imagen" className="rounded-lg p-2 text-white/70 hover:bg-white/10 hover:text-white"><Download className="h-4 w-4" /></a>
                <button type="button" aria-label="Cerrar vista" onClick={onClose} className="rounded-lg p-2 text-white/70 hover:bg-white/10 hover:text-white"><X className="h-4 w-4" /></button>
              </div>
            </div>
            <div className="p-5">
              {sourceTaskId && <button type="button" onClick={() => setEditing(true)} className="mb-5 flex w-full items-center justify-center gap-2 rounded-xl bg-[#c62828] px-4 py-3 text-sm font-bold text-white hover:bg-[#a92121]"><Sparkles className="h-4 w-4" />Editar con IA</button>}
              {sourceTaskId ? <ImageResizePanel key={`${sourceTaskId}:${index}`} sourceTaskId={sourceTaskId} sourceIndex={index} sourceModelId={modelId} prompt={prompt} /> : <p className="text-sm text-white/60">No se encontraron los datos de esta imagen.</p>}
            </div>
          </aside>
        </div>
      </motion.div>
    </AnimatePresence>
    {editing && <ImageEditor imageUrl={images[index]} taskId={sourceTaskId} index={index} prompt={prompt} onClose={() => setEditing(false)} />}
  </>;

  return (
    <AnimatePresence>
      <motion.div
        key="lightbox"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm"
        onClick={onClose}
      >
        {/* Controls bar */}
        <div
          className="absolute top-4 right-4 flex gap-2"
          onClick={(e) => e.stopPropagation()}
        >
          {isVideo && (
            <Button variant="ghost" size="icon" className="text-white hover:bg-white/10" onClick={() => setMuted(!muted)}>
              {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
            </Button>
          )}
          <a
            href={images[index]}
            download
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "ghost", size: "icon" }) + " text-white hover:bg-white/10"}
          >
            <Download className="h-5 w-5" />
          </a>
          <Button variant="ghost" size="icon" className="text-white hover:bg-white/10" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Prev */}
        {images.length > 1 && (
          <button
            className="absolute left-4 text-white hover:bg-white/10 p-2 rounded-full transition-colors"
            onClick={(e) => { e.stopPropagation(); onPrev(); }}
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}

        {/* Media */}
        <motion.div
          key={index}
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.9, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="max-w-[90vw] max-h-[90vh]"
          onClick={(e) => e.stopPropagation()}
        >
          {isVideo ? (
            <video
              ref={videoRef}
              key={images[index]}
              src={images[index]}
              className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
              autoPlay
              loop
              playsInline
              muted={muted}
              controls
            />
          ) : (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={images[index]}
              alt={`Image ${index + 1} of ${images.length}`}
              className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
            />
          )}
        </motion.div>

        {/* Next */}
        {images.length > 1 && (
          <button
            className="absolute right-4 text-white hover:bg-white/10 p-2 rounded-full transition-colors"
            onClick={(e) => { e.stopPropagation(); onNext(); }}
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        )}

        {/* Dot pagination */}
        {images.length > 1 && (
          <div className="absolute bottom-6 flex gap-1.5" onClick={(e) => e.stopPropagation()}>
            {images.map((_, i) => (
              <div
                key={i}
                className={`h-1.5 rounded-full transition-all duration-200 ${i === index ? "w-4 bg-white" : "w-1.5 bg-white/40"}`}
              />
            ))}
          </div>
        )}

        {/* Model info */}
        {modelId && (
          <div
            className={`absolute ${images.length > 1 ? "bottom-12" : "bottom-6"} text-xs font-medium px-3 py-1 rounded-lg`}
            style={{ background: "rgba(0,0,0,.6)", color: "rgba(244,247,251,.8)", backdropFilter: "blur(8px)" }}
            onClick={(e) => e.stopPropagation()}
          >
            {modelId}
          </div>
        )}

        {/* Prompt */}
        {prompt && (
          <div
            className="absolute top-4 left-4 max-w-[60vw] text-sm leading-relaxed px-4 py-2 rounded-xl"
            style={{ background: "rgba(0,0,0,.6)", color: "rgba(244,247,251,.85)", backdropFilter: "blur(8px)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <p className="line-clamp-4">{prompt}</p>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
