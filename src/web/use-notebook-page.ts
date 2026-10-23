import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";

/** Keep page data and conversation selection within the current notebook load. */
export function useNotebookPage(
  notebookId: string,
  onError: (message: string) => void,
) {
  const [loaded, setLoaded] = useState<{ selection: object; page: any } | null>(
      null,
    ),
    [convId, setConvId] = useState("");
  const nbRef = useRef(notebookId),
    selection = useRef({ id: notebookId, request: 0 }),
    mounted = useRef(true);
  nbRef.current = notebookId;
  if (selection.current.id !== notebookId)
    selection.current = { id: notebookId, request: 0 };

  const refresh = useCallback(async (id = nbRef.current) => {
    if (!id) return;
    const current = selection.current;
    // A completed action from another notebook may request its data, but must
    // not supersede an active notebook's refresh.
    const request = id === current.id ? ++current.request : 0;
    const page = await api("/notebooks/" + id);
    if (
      mounted.current &&
      selection.current === current &&
      id === current.id &&
      request === current.request
    ) {
      setLoaded({ selection: current, page });
      setConvId((previous) =>
        page.conversations.some((c: any) => c.id === previous)
          ? previous
          : (page.conversations[0]?.id ?? ""),
      );
    }
    return page;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let alive = true;
    if (notebookId)
      void refresh(notebookId).catch((e) => {
        if (alive)
          onError(e instanceof Error ? e.message : "Unable to load notebook.");
      });
    return () => {
      alive = false;
    };
  }, [notebookId, refresh, onError]);

  return {
    page: loaded?.selection === selection.current ? loaded.page : null,
    convId,
    setConvId,
    refresh,
    nbRef,
  };
}
