import { useEffect, useRef, useState, type CSSProperties } from "react";
import { AudioLines, Pause, Play, Volume1, Volume2, VolumeX } from "lucide-react";

const VOLUME_KEY = "s3b:volume";
const savedVolume = () => {
  try {
    const v = parseFloat(localStorage.getItem(VOLUME_KEY) ?? "");
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  } catch {
    return 1;
  }
};
const time = (s: number) => {
  if (!Number.isFinite(s)) return "0:00";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(Math.floor(s % 60)).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};
/** Fills the range track up to the value (see .range in index.css). */
const filled = (value: number, max: number) => ({ "--p": `${max ? (value / max) * 100 : 0}%` }) as CSSProperties;

/** Audio player in the app's style: play/pause, seek, volume with mute. Space, ↑/↓ and M work too. */
export function AudioPlayer({ src, name, onReady, onError }: { src: string; name: string; onReady: () => void; onError: () => void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(savedVolume);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    if (audio.current) audio.current.volume = volume;
    try {
      localStorage.setItem(VOLUME_KEY, String(volume));
    } catch {}
  }, [volume]);
  useEffect(() => {
    if (audio.current) audio.current.muted = muted;
  }, [muted]);

  const toggle = () => {
    const a = audio.current;
    if (a) a.paused ? a.play().catch(() => {}) : a.pause();
  };
  const changeVolume = (v: number | ((old: number) => number)) => {
    setVolume((old) => Math.min(1, Math.max(0, typeof v === "function" ? v(old) : v)));
    setMuted(false);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement) return;
      if (e.key === " ") toggle();
      else if (e.key === "ArrowUp") changeVolume((v) => v + 0.05);
      else if (e.key === "ArrowDown") changeVolume((v) => v - 0.05);
      else if (e.key === "m") setMuted((m) => !m);
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  });

  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const shown = muted ? 0 : volume;

  return (
    <div className="flex w-full max-w-md animate-rise flex-col gap-5 rounded-lg border bg-card p-6 shadow-2xl">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-md bg-accent">
          <AudioLines className={playing ? "size-5 animate-pulse" : "size-5 text-muted-foreground"} />
        </div>
        <span className="truncate font-medium" title={name}>
          {name}
        </span>
      </div>

      <audio
        ref={audio}
        src={src}
        autoPlay
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          setDuration(e.currentTarget.duration);
          e.currentTarget.volume = volume;
        }}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onLoadedData={onReady}
        onError={onError}
      />

      <div className="grid gap-1.5">
        <input
          type="range"
          className="range w-full"
          min={0}
          max={duration || 0}
          step="any"
          value={Math.min(t, duration || 0)}
          style={filled(t, duration)}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (audio.current) audio.current.currentTime = v;
            setT(v);
          }}
          aria-label="Seek"
        />
        <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>{time(t)}</span>
          <span>{time(duration)}</span>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto_1fr] items-center">
        <div className="flex items-center gap-2">
          <button
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => setMuted(!muted)}
            aria-label={muted ? "Unmute (M)" : "Mute (M)"}
            title={muted ? "Unmute (M)" : "Mute (M)"}
          >
            <VolumeIcon className="size-4" />
          </button>
          <input
            type="range"
            className="range w-24"
            min={0}
            max={1}
            step={0.01}
            value={shown}
            style={filled(shown, 1)}
            onChange={(e) => changeVolume(Number(e.target.value))}
            aria-label="Volume"
            title={`Volume ${Math.round(shown * 100)}%`}
          />
        </div>
        <button
          className="flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform hover:scale-105 active:scale-95"
          onClick={toggle}
          aria-label={playing ? "Pause (Space)" : "Play (Space)"}
          title={playing ? "Pause (Space)" : "Play (Space)"}
        >
          {playing ? <Pause className="size-5 fill-current" /> : <Play className="ml-0.5 size-5 fill-current" />}
        </button>
        <div />
      </div>
    </div>
  );
}
