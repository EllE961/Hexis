/**
 * Onboarding — 5-step first-launch tutorial overlay.
 *
 * Spotlight/tooltip walkthrough that teaches new users the Hexis interface.
 * Shown once on first launch, gated by `prefsStore.onboarded`.
 *
 * Steps:
 *   1. Welcome to Hexis          (centered card)
 *   2. Your Honeycomb             (spotlight hex grid)
 *   3. Click to Edit              (spotlight a cell)
 *   4. AI Agents                  (spotlight AI button)
 *   5. Command Palette            (spotlight status bar)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { usePrefsStore } from '../../stores/prefsStore.js';
import { colors, easing } from '../../theme/tokens.js';

// ─── Step definitions ────────────────────────────────────────────

const STEPS = [
  {
    id: 'welcome',
    title: 'Welcome to Hexis',
    description:
      'Your codebase, visualized as a living honeycomb. Every file is a hex cell, every folder a cluster. Navigate, edit, and command your project from a single surface.',
    spotlight: null, // centered card, no spotlight target
    icon: '⬡',
  },
  {
    id: 'honeycomb',
    title: 'Your Honeycomb',
    description:
      'Each hexagon represents a file in your project. Colors map to folder groups — related files cluster together so you can see architecture at a glance.',
    spotlight: 'hex-grid',
    icon: '🍯',
  },
  {
    id: 'click-to-edit',
    title: 'Click to Edit',
    description:
      'Click any hex to open its file in the editor panel. Double-click to zoom the grid onto that cell. Your changes auto-save.',
    spotlight: 'hex-cell',
    icon: '✏️',
  },
  {
    id: 'ai-agents',
    title: 'AI Agents',
    description:
      'Press Ctrl+I or tap the bee button to summon AI agents. Describe a task — the hive will plan, code, test, and review it for you.',
    spotlight: 'ai-button',
    icon: '🐝',
  },
  {
    id: 'command-palette',
    title: 'Command Palette',
    description:
      'Ctrl+K opens the command palette — fuzzy-search files, run commands, switch branches. Ctrl+G opens the git panel for commits, pushes, and diffs.',
    spotlight: 'status-bar',
    icon: '⌘',
  },
];

// ─── Spotlight geometry helpers ──────────────────────────────────

function getSpotlightRect(spotlightTarget) {
  if (!spotlightTarget) return null;

  const selectors = {
    'hex-grid': () => {
      // Target the main canvas area — center region
      const canvas = document.querySelector('canvas');
      if (canvas) {
        const r = canvas.getBoundingClientRect();
        // Inset so the spotlight frames the grid center, not the full viewport
        const inset = Math.min(r.width, r.height) * 0.15;
        return {
          x: r.left + inset,
          y: r.top + inset,
          width: r.width - inset * 2,
          height: r.height - inset * 2,
          borderRadius: 24,
        };
      }
      return null;
    },
    'hex-cell': () => {
      // Try to find a hex cell in the canvas center region
      const canvas = document.querySelector('canvas');
      if (canvas) {
        const r = canvas.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        return {
          x: cx - 50,
          y: cy - 55,
          width: 100,
          height: 110,
          borderRadius: 12,
        };
      }
      return null;
    },
    'ai-button': () => {
      // Find the AI button in the status bar (contains bee emoji)
      const buttons = document.querySelectorAll('.absolute.bottom-0 button');
      for (const btn of buttons) {
        if (btn.textContent.includes('AI') || btn.textContent.includes('\uD83D\uDC1D')) {
          const r = btn.getBoundingClientRect();
          return {
            x: r.left - 6,
            y: r.top - 6,
            width: r.width + 12,
            height: r.height + 12,
            borderRadius: 8,
          };
        }
      }
      return null;
    },
    'status-bar': () => {
      const bar = document.querySelector('.absolute.bottom-0.left-0.right-0');
      if (bar) {
        const r = bar.getBoundingClientRect();
        return {
          x: r.left,
          y: r.top - 4,
          width: r.width,
          height: r.height + 4,
          borderRadius: 0,
        };
      }
      return null;
    },
  };

  const getter = selectors[spotlightTarget];
  return getter ? getter() : null;
}

// ─── Tooltip positioning ─────────────────────────────────────────

function getTooltipPosition(spotlightRect) {
  if (!spotlightRect) return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const tooltipW = 380;
  const tooltipH = 220;
  const gap = 20;

  const cx = spotlightRect.x + spotlightRect.width / 2;
  const cy = spotlightRect.y + spotlightRect.height / 2;

  // Prefer placing below the spotlight
  if (spotlightRect.y + spotlightRect.height + gap + tooltipH < vh) {
    return {
      top: spotlightRect.y + spotlightRect.height + gap,
      left: Math.max(16, Math.min(cx - tooltipW / 2, vw - tooltipW - 16)),
    };
  }
  // Above
  if (spotlightRect.y - gap - tooltipH > 0) {
    return {
      top: spotlightRect.y - gap - tooltipH,
      left: Math.max(16, Math.min(cx - tooltipW / 2, vw - tooltipW - 16)),
    };
  }
  // Right
  if (spotlightRect.x + spotlightRect.width + gap + tooltipW < vw) {
    return {
      top: Math.max(16, Math.min(cy - tooltipH / 2, vh - tooltipH - 16)),
      left: spotlightRect.x + spotlightRect.width + gap,
    };
  }
  // Left
  return {
    top: Math.max(16, Math.min(cy - tooltipH / 2, vh - tooltipH - 16)),
    left: Math.max(16, spotlightRect.x - gap - tooltipW),
  };
}

// ─── SVG overlay with spotlight cutout ───────────────────────────

function SpotlightOverlay({ rect, opacity }) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (!rect) {
    // Full dark overlay, no cutout
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9998,
          background: `rgba(0, 0, 0, ${0.82 * opacity})`,
          transition: `opacity 0.4s ${easing.decelerate}`,
        }}
      />
    );
  }

  const r = rect.borderRadius || 0;

  return (
    <svg
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        zIndex: 9998,
        transition: `opacity 0.4s ${easing.decelerate}`,
        opacity,
      }}
    >
      <defs>
        <mask id="hexis-spotlight-mask">
          <rect x="0" y="0" width={vw} height={vh} fill="white" />
          <rect
            x={rect.x}
            y={rect.y}
            width={rect.width}
            height={rect.height}
            rx={r}
            ry={r}
            fill="black"
          />
        </mask>
      </defs>
      <rect
        x="0"
        y="0"
        width={vw}
        height={vh}
        fill="rgba(0, 0, 0, 0.82)"
        mask="url(#hexis-spotlight-mask)"
      />
      {/* Amber glow ring around the cutout */}
      <rect
        x={rect.x - 2}
        y={rect.y - 2}
        width={rect.width + 4}
        height={rect.height + 4}
        rx={r + 2}
        ry={r + 2}
        fill="none"
        stroke="rgba(240, 160, 48, 0.35)"
        strokeWidth="2"
      />
    </svg>
  );
}

// ─── Step indicator dots ─────────────────────────────────────────

function StepDots({ current, total }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          style={{
            width: i === current ? 20 : 6,
            height: 6,
            borderRadius: 3,
            background: i === current ? colors.accent : 'rgba(139, 148, 158, 0.25)',
            transition: `all 0.3s ${easing.microspring}`,
          }}
        />
      ))}
    </div>
  );
}

// ─── Main Onboarding component ───────────────────────────────────

export default function Onboarding() {
  const onboarded = usePrefsStore(s => s.onboarded);
  const completeOnboarding = usePrefsStore(s => s.completeOnboarding);

  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);
  const [opacity, setOpacity] = useState(0);
  const [tooltipOpacity, setTooltipOpacity] = useState(0);
  const [spotlightRect, setSpotlightRect] = useState(null);
  const tooltipRef = useRef(null);

  const currentStep = STEPS[step];
  const isLastStep = step === STEPS.length - 1;
  const isFirstStep = step === 0;

  // Entrance animation
  useEffect(() => {
    if (onboarded) return;
    // Small delay so the app renders beneath first
    const t1 = setTimeout(() => setVisible(true), 400);
    const t2 = setTimeout(() => setOpacity(1), 500);
    const t3 = setTimeout(() => setTooltipOpacity(1), 700);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [onboarded]);

  // Update spotlight rect when step changes or window resizes
  useEffect(() => {
    if (!visible) return;

    function update() {
      setSpotlightRect(getSpotlightRect(currentStep.spotlight));
    }

    // Fade tooltip out, reposition, fade back in
    setTooltipOpacity(0);
    const tMove = setTimeout(() => {
      update();
      setTooltipOpacity(1);
    }, 200);

    window.addEventListener('resize', update);
    return () => {
      clearTimeout(tMove);
      window.removeEventListener('resize', update);
    };
  }, [step, visible, currentStep.spotlight]);

  const handleNext = useCallback(() => {
    if (isLastStep) {
      handleFinish();
    } else {
      setStep(s => s + 1);
    }
  }, [isLastStep]);

  const handleFinish = useCallback(() => {
    setTooltipOpacity(0);
    setOpacity(0);
    setTimeout(() => {
      setVisible(false);
      completeOnboarding();
    }, 400);
  }, [completeOnboarding]);

  // Keyboard navigation
  useEffect(() => {
    if (!visible) return;
    const handler = (e) => {
      if (e.key === 'Escape') {
        handleFinish();
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        handleNext();
      } else if (e.key === 'ArrowLeft' && step > 0) {
        setStep(s => s - 1);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [visible, step, handleNext, handleFinish]);

  // Don't render if already onboarded or not yet visible
  if (onboarded || !visible) return null;

  const tooltipPos = getTooltipPosition(spotlightRect);
  const isCentered = !currentStep.spotlight;

  return (
    <>
      {/* Dark overlay with spotlight cutout */}
      <SpotlightOverlay rect={spotlightRect} opacity={opacity} />

      {/* Tooltip card */}
      <div
        ref={tooltipRef}
        style={{
          position: 'fixed',
          zIndex: 9999,
          ...(isCentered
            ? { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
            : { top: tooltipPos.top, left: tooltipPos.left }
          ),
          width: isCentered ? 420 : 380,
          opacity: tooltipOpacity,
          transition: `opacity 0.35s ${easing.decelerate}, transform 0.35s ${easing.microspring}`,
        }}
      >
        <div
          style={{
            background: colors.bgSurface,
            border: `1px solid rgba(240, 160, 48, 0.2)`,
            borderRadius: 16,
            padding: isCentered ? '36px 32px 28px' : '24px 24px 20px',
            boxShadow: '0 24px 80px rgba(0, 0, 0, 0.6), 0 0 60px rgba(240, 160, 48, 0.08)',
          }}
        >
          {/* Icon */}
          <div
            style={{
              fontSize: isCentered ? 40 : 28,
              marginBottom: isCentered ? 16 : 10,
              textAlign: isCentered ? 'center' : 'left',
              lineHeight: 1,
            }}
          >
            {currentStep.icon}
          </div>

          {/* Title */}
          <h2
            style={{
              margin: 0,
              marginBottom: isCentered ? 14 : 8,
              fontSize: isCentered ? 22 : 17,
              fontWeight: 600,
              color: colors.textPrimary,
              textAlign: isCentered ? 'center' : 'left',
              letterSpacing: '-0.01em',
            }}
          >
            {currentStep.title}
          </h2>

          {/* Description */}
          <p
            style={{
              margin: 0,
              marginBottom: isCentered ? 28 : 20,
              fontSize: 13.5,
              lineHeight: 1.6,
              color: colors.textSecondary,
              textAlign: isCentered ? 'center' : 'left',
            }}
          >
            {currentStep.description}
          </p>

          {/* Footer: dots + buttons */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <StepDots current={step} total={STEPS.length} />

            <div style={{ display: 'flex', gap: 8 }}>
              {/* Skip button */}
              <button
                onClick={handleFinish}
                style={{
                  background: 'none',
                  border: 'none',
                  color: colors.textTertiary,
                  fontSize: 12.5,
                  fontWeight: 500,
                  cursor: 'pointer',
                  padding: '6px 12px',
                  borderRadius: 8,
                  transition: `color 0.2s ${easing.default}`,
                }}
                onMouseEnter={(e) => e.target.style.color = colors.textSecondary}
                onMouseLeave={(e) => e.target.style.color = colors.textTertiary}
              >
                Skip
              </button>

              {/* Next / Got it / Start Building */}
              <button
                onClick={handleNext}
                style={{
                  background: isLastStep
                    ? `linear-gradient(135deg, ${colors.accent}, ${colors.accentHover})`
                    : colors.accent,
                  border: 'none',
                  color: colors.bgDeep,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  padding: '8px 20px',
                  borderRadius: 10,
                  letterSpacing: '-0.01em',
                  boxShadow: isLastStep
                    ? '0 4px 20px rgba(240, 160, 48, 0.35), inset 0 1px 0 rgba(255,255,255,0.15)'
                    : '0 2px 10px rgba(240, 160, 48, 0.2)',
                  transition: `transform 0.15s ${easing.microspring}, box-shadow 0.2s ${easing.default}`,
                }}
                onMouseEnter={(e) => {
                  e.target.style.transform = 'scale(1.04)';
                  e.target.style.boxShadow = '0 6px 24px rgba(240, 160, 48, 0.45)';
                }}
                onMouseLeave={(e) => {
                  e.target.style.transform = 'scale(1)';
                  e.target.style.boxShadow = isLastStep
                    ? '0 4px 20px rgba(240, 160, 48, 0.35)'
                    : '0 2px 10px rgba(240, 160, 48, 0.2)';
                }}
              >
                {isLastStep ? 'Start Building' : isFirstStep ? 'Next' : step === STEPS.length - 2 ? 'Got it' : 'Next'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
