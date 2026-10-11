import React, { useState, useEffect, useRef } from "react";
import type { Answer, Citation } from "../domain/evidence.ts";
import type { MapNode } from "../domain/structured.ts";

function References({
  citations,
  label,
  openPassage,
}: {
  citations: Citation[];
  label: string;
  openPassage: (citation: Citation) => void;
}) {
  return (
    <>
      {citations.map((citation, i) => (
        <button
          key={i}
          className="citation"
          aria-label={`Open evidence for ${label}, reference ${i + 1}`}
          onClick={() => openPassage(citation)}
        >
          {i + 1}
        </button>
      ))}
    </>
  );
}
function Block({
  block,
  label,
  openPassage,
}: {
  block: Answer["blocks"][number];
  label: string;
  openPassage: (citation: Citation) => void;
}) {
  return (
    <div className={`answer-block ${block.kind}`}>
      <p>{block.text}</p>
      <References
        citations={block.citations}
        label={label}
        openPassage={openPassage}
      />
      {block.kind === "inference" && (
        <span className="inference-label">Inference</span>
      )}
    </div>
  );
}
export function mapLayout(nodes: MapNode[], collapsed: ReadonlySet<string>) {
  const positioned: { node: MapNode; x: number; y: number }[] = [];
  let leaf = 0;
  function visit(node: MapNode, depth: number): number {
    const children = collapsed.has(node.id)
      ? []
      : nodes.filter((n) => n.parentId === node.id);
    const ys = children.map((child) => visit(child, depth + 1));
    const y = ys.length ? (ys[0] + ys[ys.length - 1]) / 2 : 50 + leaf++ * 110;
    positioned.push({ node, x: 20 + depth * 250, y });
    return y;
  }
  if (nodes[0]) visit(nodes[0], 0);
  // Keep the first branches visible around the root while deeper detail can be panned.
  const root = positioned.find((p) => p.node.parentId === null);
  if (root) {
    const branches = nodes.filter((node) => node.parentId === root.node.id);
    branches.forEach((node, i) => {
      const position = positioned.find((p) => p.node.id === node.id);
      if (position) position.y = root.y + (i - (branches.length - 1) / 2) * 110;
    });
  }
  return {
    positioned,
    width: Math.max(300, ...positioned.map((n) => n.x + 230)),
    height: Math.max(140, leaf * 110 + 20),
  };
}
function labelLines(label: string) {
  const lines: string[] = [];
  let current = "";
  for (const word of label.split(/\s+/)) {
    if (current && Array.from(current + " " + word).length > 25) {
      lines.push(current);
      current = "";
    }
    const chars = Array.from(word);
    while (chars.length > 25) {
      if (current) {
        lines.push(current);
        current = "";
      }
      lines.push(chars.splice(0, 25).join(""));
    }
    if (chars.length) current += (current ? " " : "") + chars.join("");
  }
  if (current) lines.push(current);
  if (lines.length > 3)
    lines[2] = Array.from(lines[2]).slice(0, 24).join("") + "…";
  return lines.slice(0, 3);
}
export function StructuredMaterial({
  content,
  openPassage,
}: {
  content: Answer;
  openPassage: (citation: Citation) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const canvas = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!canvas.current || !content.nodes?.length) return;
    const root = mapLayout(content.nodes, collapsed).positioned.find(
      (p) => p.node.parentId === null,
    )!;
    const align = () => {
      if (canvas.current?.clientHeight)
        canvas.current.scrollTop = Math.max(
          0,
          root.y - canvas.current.clientHeight / 2,
        );
    };
    const observer = new ResizeObserver(align);
    observer.observe(canvas.current);
    align();
    return () => observer.disconnect();
  }, [content.nodes, collapsed]);
  if (content.kind === "data-table")
    return (
      <div className="structured-material">
        <p className="fine">
          “Not stated” means the selected evidence did not supply a value.
          Scroll the table to see all columns.
        </p>
        <div
          className="data-table-scroll"
          role="region"
          tabIndex={0}
          aria-label="Data table; scroll to view all columns"
        >
          <table className="data-table">
            <caption>{content.title}</caption>
            <thead>
              <tr>
                <th scope="col">Item</th>
                {content.columns!.map((column) => (
                  <th scope="col" key={column.id}>
                    {column.label}
                    <References
                      citations={column.labelCitations}
                      label={`column ${column.label}`}
                      openPassage={openPassage}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {content.rows!.map((row) => (
                <tr key={row.id}>
                  <th scope="row">
                    {row.label}
                    <References
                      citations={row.labelCitations}
                      label={`row ${row.label}`}
                      openPassage={openPassage}
                    />
                  </th>
                  {row.cells.map((cell, i) => (
                    <td key={cell.columnId}>
                      {cell.blockIndexes.length ? (
                        cell.blockIndexes.map((index) => (
                          <Block
                            key={index}
                            block={content.blocks[index]}
                            label={`${row.label}, ${content.columns![i].label}`}
                            openPassage={openPassage}
                          />
                        ))
                      ) : (
                        <span className="fine">Not stated</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  const nodes = content.nodes!,
    { positioned, width, height } = mapLayout(nodes, collapsed);
  const byId = new Map(
    positioned.map((position) => [position.node.id, position]),
  );
  const branch = (node: MapNode): React.ReactNode => {
    const children = nodes.filter((n) => n.parentId === node.id),
      closed = collapsed.has(node.id);
    return (
      <li key={node.id}>
        <div className="map-outline-node">
          {children.length ? (
            <button
              className="map-branch"
              aria-expanded={!closed}
              aria-label={`${closed ? "Expand" : "Collapse"} branch ${node.label}`}
              onClick={() =>
                setCollapsed((previous) => {
                  const next = new Set(previous);
                  if (closed) next.delete(node.id);
                  else next.add(node.id);
                  return next;
                })
              }
            >
              {closed ? "▸" : "▾"} {node.label}
            </button>
          ) : (
            <strong>{node.label}</strong>
          )}
          <References
            citations={node.labelCitations}
            label={`node ${node.label}`}
            openPassage={openPassage}
          />
          {node.parentId && (
            <p className="map-relation">
              Relationship to {nodes.find((n) => n.id === node.parentId)!.label}
              : {node.relation}
              <References
                citations={node.relationCitations}
                label={`relationship ${node.label}`}
                openPassage={openPassage}
              />
            </p>
          )}
          {node.blockIndexes.map((index) => (
            <Block
              key={index}
              block={content.blocks[index]}
              label={`node ${node.label} detail`}
              openPassage={openPassage}
            />
          ))}
        </div>
        {!closed && children.length > 0 && <ul>{children.map(branch)}</ul>}
      </li>
    );
  };
  return (
    <div className="structured-material">
      <p className="fine">
        Use the outline to collapse branches or inspect evidence. Scroll the map
        to see all branches.
      </p>
      <div
        ref={canvas}
        className="mind-map-scroll"
        role="region"
        tabIndex={0}
        aria-label="Mind map canvas; scroll to view branches"
      >
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`Connected mind map: ${content.title}. Full labels and evidence are in the outline.`}
        >
          {positioned
            .filter((p) => p.node.parentId)
            .map((p) => {
              const parent = byId.get(p.node.parentId!)!;
              return (
                <path
                  key={p.node.id}
                  d={`M ${parent.x + 210} ${parent.y} C ${parent.x + 230} ${parent.y}, ${p.x - 20} ${p.y}, ${p.x} ${p.y}`}
                  fill="none"
                  stroke="#789081"
                  strokeWidth="2"
                />
              );
            })}
          {positioned.map(({ node, x, y }) => (
            <g key={node.id}>
              <title>
                {node.label}
                {node.parentId ? ` — ${node.relation}` : ""}
              </title>
              <rect
                x={x}
                y={y - 37}
                width={210}
                height={74}
                rx={12}
                fill="#f2f7ef"
                stroke="#b7c9b7"
              />
              {labelLines(node.label).map((line, i) => (
                <text
                  key={i}
                  x={x + 12}
                  y={y - 15 + i * 18}
                  fontSize="13"
                  fill="#26382b"
                >
                  {line}
                </text>
              ))}
            </g>
          ))}
        </svg>
      </div>
      <h3>Map outline</h3>
      <ul className="map-outline">{nodes[0] && branch(nodes[0])}</ul>
    </div>
  );
}
