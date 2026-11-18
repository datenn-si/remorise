import { useEffect, useRef, useState } from 'react';
import {
  BLINK_MIN_GAP_MS,
  BLINK_STEP_MS,
  DEFAULT_SPRITE,
  MOUTH_INTERVAL_MS,
  blinkGapMs,
  type EyeFrame,
  type EyeState,
  type MouthFrame,
  type MouthState,
  type SpriteConfig,
} from '../lib/spriteLayers';

export { BLINK_MIN_GAP_MS, BLINK_STEP_MS, MOUTH_INTERVAL_MS };

export function nextBlinkDelay(
  random: () => number = Math.random,
  hurried = false,
  sprite: SpriteConfig = DEFAULT_SPRITE,
): number {
  const mean = blinkGapMs(hurried, sprite);
  const unit = Math.min(Math.max(random(), 0), 0.999999);
  const sample = -mean * Math.log(1 - unit);
  if (!Number.isFinite(sample)) return Math.max(BLINK_MIN_GAP_MS, mean);
  return Math.max(BLINK_MIN_GAP_MS, sample);
}

function eyeRest(eyes: EyeState): EyeFrame {
  if (eyes === 'closed') return 2;
  if (eyes === 'half') return 1;
  return 0;
}

function mouthRest(mouth: MouthState): MouthFrame {
  if (mouth === 'open') return 2;
  if (mouth === 'half') return 1;
  return 0;
}

function between(from: number, to: number): number[] {
  if (from === to) return [];
  if (Math.abs(from - to) > 1) return [1, to];
  return [to];
}

export function useSpriteAnimation(input: {
  eyes: EyeState;
  eyesLeft?: EyeState;
  eyesRight?: EyeState;
  mouth: MouthState;
  blinking: boolean;
  talking: boolean;
  sprite?: SpriteConfig;
  hurried?: boolean;
  animateChanges?: boolean;
}): { eyeFrameLeft: EyeFrame; eyeFrameRight: EyeFrame; mouthFrame: MouthFrame } {
  const {
    eyes,
    mouth,
    blinking,
    talking,
    sprite = DEFAULT_SPRITE,
    hurried = false,
    animateChanges = false,
  } = input;
  // Per-side states default to the shared one: chat passes only the
  // shared state, so both sides move together there. Blinking is
  // shared too — it runs only while both sides rest open, and steps
  // both sides through the same cycle.
  const eyesLeft = input.eyesLeft ?? eyes;
  const eyesRight = input.eyesRight ?? eyes;
  const [eyeFrameLeft, setEyeFrameLeft] = useState<EyeFrame>(eyeRest(eyesLeft));
  const [eyeFrameRight, setEyeFrameRight] = useState<EyeFrame>(eyeRest(eyesRight));
  const [mouthFrame, setMouthFrame] = useState<MouthFrame>(mouthRest(mouth));
  const eyeLeftRef = useRef(eyeFrameLeft);
  const eyeRightRef = useRef(eyeFrameRight);
  const mouthRef = useRef(mouthFrame);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const setFrames = (left: EyeFrame, right: EyeFrame) => {
      eyeLeftRef.current = left;
      eyeRightRef.current = right;
      setEyeFrameLeft(left);
      setEyeFrameRight(right);
    };
    const bothOpen = eyesLeft === 'open' && eyesRight === 'open';
    const startBlink = () => {
      if (!(bothOpen && blinking)) return;
      let index = 0;
      const advance = () => {
        if (cancelled) return;
        if (index >= sprite.blink.cycle.length) {
          setFrames(0, 0);
          timer = window.setTimeout(advance, nextBlinkDelay(Math.random, hurried, sprite));
          index = 0;
          return;
        }
        const frame = sprite.blink.cycle[index] as EyeFrame;
        setFrames(frame, frame);
        index += 1;
        timer = window.setTimeout(advance, sprite.blink.stepMs);
      };
      setFrames(0, 0);
      timer = window.setTimeout(advance, sprite.blink.stepMs);
    };

    if (!animateChanges && bothOpen && blinking) {
      startBlink();
    } else if (!animateChanges) {
      setFrames(eyeRest(eyesLeft), eyeRest(eyesRight));
    } else {
      const framesLeft = between(eyeLeftRef.current, eyeRest(eyesLeft));
      const framesRight = between(eyeRightRef.current, eyeRest(eyesRight));
      const steps = Math.max(framesLeft.length, framesRight.length);
      let index = 0;
      const show = () => {
        if (cancelled) return;
        if (index >= steps) {
          startBlink();
          return;
        }
        setFrames(
          index < framesLeft.length ? (framesLeft[index] as EyeFrame) : eyeLeftRef.current,
          index < framesRight.length ? (framesRight[index] as EyeFrame) : eyeRightRef.current,
        );
        index += 1;
        timer = window.setTimeout(show, BLINK_STEP_MS);
      };
      if (steps === 0) startBlink();
      else show();
    }

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [animateChanges, blinking, eyesLeft, eyesRight, hurried, sprite]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const setFrame = (frame: MouthFrame) => {
      mouthRef.current = frame;
      setMouthFrame(frame);
    };
    if (talking) {
      let index = 0;
      setFrame(sprite.talk.cycle[0] as MouthFrame);
      timer = window.setInterval(() => {
        index = (index + 1) % sprite.talk.cycle.length;
        setFrame(sprite.talk.cycle[index] as MouthFrame);
      }, sprite.talk.intervalMs);
      return () => {
        cancelled = true;
        window.clearInterval(timer);
      };
    }

    const frames = animateChanges
      ? between(mouthRef.current, mouthRest(mouth))
      : [mouthRest(mouth)];
    let index = 0;
    const show = () => {
      if (cancelled) return;
      if (index >= frames.length) return;
      setFrame(frames[index] as MouthFrame);
      index += 1;
      timer = window.setTimeout(show, sprite.talk.intervalMs);
    };
    if (frames.length > 0) show();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [animateChanges, mouth, sprite, talking]);

  return { eyeFrameLeft, eyeFrameRight, mouthFrame };
}
