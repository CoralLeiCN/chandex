import type { Answer, Citation } from "../domain/evidence.ts";

export function InfographicMaterial({
  content,
  openPassage,
}: {
  content: Answer;
  openPassage: (citation: Citation) => void;
}) {
  const data = content.infographic;
  if (!data?.cards.length) return null;
  const claim = (index: number) => {
    const b = content.blocks[index];
    return (
      <>
        <span>
          {b.kind === "inference" && <strong>Inference: </strong>}
          {b.text}
        </span>
        {b.citations.map((c, i) => (
          <button
            type="button"
            className="citation"
            key={i}
            onClick={() => openPassage(c)}
            aria-label={`Open reference ${i + 1} for infographic claim ${index + 1}`}
          >
            {i + 1}
          </button>
        ))}
      </>
    );
  };
  return (
    <section className="infographic-material" aria-label="Cited infographic">
      {data.orderBlockIndex !== null && (
        <div className="infographic-order">
          <strong>Source-supported order: </strong>
          {claim(data.orderBlockIndex)}
        </div>
      )}
      <div className={`infographic-cards infographic-${data.layout}`}>
        {data.cards.map((card, i) => (
          <section
            className="infographic-card"
            key={card.id}
            aria-label={
              data.layout === "steps"
                ? `Step ${i + 1}`
                : data.layout === "comparison"
                  ? `Position ${i + 1}`
                  : `Card ${i + 1}`
            }
          >
            {data.layout === "steps" && (
              <span className="eyebrow">Step {i + 1}</span>
            )}
            <h3>{claim(card.headlineBlockIndex)}</h3>
            {card.bodyBlockIndexes.map((index) => (
              <p key={index}>{claim(index)}</p>
            ))}
          </section>
        ))}
      </div>
      <p className="fine">
        References open stored evidence. Check important claims and
        relationships before sharing.
      </p>
    </section>
  );
}
