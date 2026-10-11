import { useState } from "react";
import type { Answer, Citation } from "../domain/evidence.ts";
import type { DeckSlide } from "../domain/slides.ts";

export function SlideMaterial({
  content,
  openPassage,
}: {
  content: Answer;
  openPassage: (citation: Citation) => void;
}) {
  const slides = content.slides ?? [],
    [position, setPosition] = useState(0);
  if (!slides.length) return null;
  const current = slides[Math.min(position, slides.length - 1)];
  const claim = (index: number, headline = false) => {
    const value = content.blocks[index];
    return (
      <>
        <span>
          {value.kind === "inference" && <strong>Inference: </strong>}
          {value.text}
        </span>
        {value.citations.map((c, i) => (
          <button
            type="button"
            className="citation"
            key={i}
            onClick={() => openPassage(c)}
            aria-label={`Open reference ${i + 1} for ${headline ? "headline" : "slide claim " + (index + 1)}`}
          >
            {i + 1}
          </button>
        ))}
      </>
    );
  };
  const panel = (slide: DeckSlide, index: number) => (
    <section
      key={slide.id}
      className="deck-slide"
      aria-label={`Slide ${index + 1}`}
    >
      <span className="eyebrow">
        {index + 1} / {slides.length} · Source-grounded slides
      </span>
      <h3>{claim(slide.headlineBlockIndex, true)}</h3>
      <ul>
        {slide.bodyBlockIndexes.map((blockIndex) => (
          <li key={blockIndex}>{claim(blockIndex)}</li>
        ))}
      </ul>
      {slide.noteBlockIndexes.length > 0 && (
        <details className="deck-notes">
          <summary>Speaker notes</summary>
          {slide.noteBlockIndexes.map((blockIndex) => (
            <p key={blockIndex}>{claim(blockIndex)}</p>
          ))}
        </details>
      )}
    </section>
  );
  return (
    <div className="slide-material">
      <div
        className="deck-navigation"
        role="group"
        aria-label="Slide navigation"
      >
        <button
          type="button"
          disabled={position === 0}
          onClick={() => setPosition((p) => p - 1)}
        >
          Previous slide
        </button>
        <span role="status">
          Slide {position + 1} of {slides.length}
        </span>
        <button
          type="button"
          disabled={position === slides.length - 1}
          onClick={() => setPosition((p) => p + 1)}
        >
          Next slide
        </button>
      </div>
      <div
        tabIndex={0}
        role="region"
        aria-label="Slide viewer"
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            setPosition((p) =>
              Math.max(
                0,
                Math.min(
                  slides.length - 1,
                  p + (event.key === "ArrowRight" ? 1 : -1),
                ),
              ),
            );
          }
        }}
      >
        {panel(current, position)}
      </div>
      <p className="fine">
        Use the slide controls or focus the viewer and press Left/Right.
        References locate stored evidence; check important claims before
        presenting.
      </p>
      <details className="deck-outline">
        <summary>All slides and speaker notes</summary>
        {slides.map(panel)}
      </details>
    </div>
  );
}
