/**
 * Lightweight Web Audio API synthesizer for naval combat sound effects.
 * Zero external audio assets required; safe to instantiate before user gesture.
 */
export class SoundManager {
  #ctx: AudioContext | null = null;
  #muted = false;

  get muted(): boolean {
    return this.#muted;
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
  }

  toggleMute(): boolean {
    this.#muted = !this.#muted;
    return this.#muted;
  }

  #ensureContext(): AudioContext | null {
    if (this.#muted || typeof window === 'undefined') return null;
    if (!this.#ctx) {
      const AudioCtx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      this.#ctx = new AudioCtx();
    }
    if (this.#ctx.state === 'suspended') {
      void this.#ctx.resume();
    }
    return this.#ctx;
  }

  playCannon(): void {
    const ctx = this.#ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(160, now);
    osc.frequency.exponentialRampToValueAtTime(45, now + 0.14);
    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.16);
  }

  playExplosion(): void {
    const ctx = this.#ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(110, now);
    osc.frequency.exponentialRampToValueAtTime(28, now + 0.32);
    gain.gain.setValueAtTime(0.28, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.34);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.35);
  }

  playPickup(): void {
    const ctx = this.#ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.1);
    gain.gain.setValueAtTime(0.14, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.13);
  }
}
