import { useState, useEffect, useRef } from 'react';

interface NumberTickerProps {
  value: number;
  className?: string;
  duration?: number;
}

export function NumberTicker({ value, className = '', duration = 1500 }: NumberTickerProps) {
  const [displayValue, setDisplayValue] = useState(value);
  const previousValueRef = useRef(value);
  const [isResetting, setIsResetting] = useState(false);

  useEffect(() => {
    if (value === previousValueRef.current) return;

    // Instant reset to 0
    if (value === 0) {
      setIsResetting(true);
      setDisplayValue(0);
      previousValueRef.current = 0;

      // Turn back on transitions after a brief delay
      const timeout = window.setTimeout(() => setIsResetting(false), 50);
      return () => window.clearTimeout(timeout);
    }

    setIsResetting(false);
    let startTimestamp: number | null = null;
    const startValue = previousValueRef.current;
    const endValue = value;

    const step = (timestamp: number) => {
      if (!startTimestamp) startTimestamp = timestamp;
      const progress = Math.min((timestamp - startTimestamp) / duration, 1);

      const easeProgress = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      const current = Math.floor(easeProgress * (endValue - startValue) + startValue);

      setDisplayValue(current);

      if (progress < 1) {
        window.requestAnimationFrame(step);
      } else {
        previousValueRef.current = endValue;
      }
    };

    window.requestAnimationFrame(step);
  }, [value, duration]);

  const digits = displayValue.toLocaleString().split('');

  return (
    <span className={`ticker-container ${className} ${isResetting ? 'no-transition' : ''}`}>
      {digits.map((digit, i) => (
        <Digit key={digits.length - i} char={digit} noTransition={isResetting} />
      ))}
    </span>
  );
}

function Digit({ char, noTransition }: { char: string; noTransition?: boolean }) {
  const isNumber = !isNaN(parseInt(char));
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    if (isNumber) {
      setOffset(parseInt(char));
    }
  }, [char, isNumber]);

  if (!isNumber) {
    return <span className="ticker-char">{char}</span>;
  }

  return (
    <span className="ticker-digit-wrapper">
      <div
        className="ticker-digit-column"
        style={{
          transform: `translateY(-${offset * 10}%)`,
          transition: noTransition ? 'none' : undefined,
        }}
      >
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
          <span key={n} className="ticker-digit">
            {n}
          </span>
        ))}
      </div>
    </span>
  );
}
