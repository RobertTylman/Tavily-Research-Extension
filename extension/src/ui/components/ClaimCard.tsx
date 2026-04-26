/**
 * Claim Card Component
 *
 * Displays a single submitted claim with its verdict and citations.
 */

import { useState } from 'react';
import { Claim, Verdict } from '../../lib/types';
import { VerdictBadge } from './VerdictBadge';
import { CitationList } from './CitationList';

interface ClaimCardProps {
  claim: Claim;
  verdict?: Verdict;
}

export function ClaimCard({ claim, verdict }: ClaimCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className={`claim-card ${isExpanded ? 'expanded' : ''}`}>
      <div className="claim-header">{verdict && <VerdictBadge verdict={verdict.verdict} />}</div>

      <div className="claim-text">
        <p>{claim.text}</p>
      </div>

      {verdict && (
        <>
          <div className="confidence-section">
            <div className="confidence-label">
              <span>Confidence</span>
              <span className="confidence-value">{Math.round(verdict.confidence * 100)}%</span>
            </div>
            <div className="confidence-bar">
              <div
                className="confidence-fill"
                style={{
                  width: `${verdict.confidence * 100}%`,
                  backgroundColor: getConfidenceColor(verdict.confidence),
                }}
              />
            </div>
            {verdict.confidenceExplanation && (
              <p className="confidence-explanation">{verdict.confidenceExplanation}</p>
            )}
          </div>

          {verdict.warnings && verdict.warnings.length > 0 && (
            <div className="warnings-section">
              {verdict.warnings.map((warning, index) => (
                <div key={index} className="warning-item">
                  <span className="warning-icon">⚠️</span>
                  <span>{warning}</span>
                </div>
              ))}
            </div>
          )}

          <div className="explanation">
            <p>{verdict.explanation}</p>
          </div>

          {verdict.citations.length > 0 && (
            <button className="citations-toggle" onClick={() => setIsExpanded(!isExpanded)}>
              {isExpanded ? '▼' : '▶'} {verdict.citations.length} source
              {verdict.citations.length > 1 ? 's' : ''}
            </button>
          )}

          {isExpanded && <CitationList citations={verdict.citations} claimText={claim.text} />}
        </>
      )}
    </div>
  );
}

function getConfidenceColor(confidence: number): string {
  if (confidence >= 0.7) return '#22c55e';
  if (confidence >= 0.4) return '#f59e0b';
  return '#6b7280';
}
