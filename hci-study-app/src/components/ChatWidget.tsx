import { Card, useTheme } from "@mui/material";
import { DeepChat } from "deep-chat-react";
import { useMemo, useCallback, useRef } from "react";
import { useFlow } from "../context/FlowProvider"; // ⬅️ add this

const CHAT_BASE =
  (import.meta.env as any).VITE_CHAT_BASE ??
  (import.meta.env as any).VITE_CHAT_API_URL ??
  "/chat";

type HistoryMsg = { role: "ai" | "user"; text: string };
type DemoConfig =
  | boolean
  | {
      response?: (message: any) => { text: string };
    };

type Props = {
  history?: HistoryMsg[];
  demo?: DemoConfig;
};

function getUserId() {
  const k = "study_user_id";
  let id = localStorage.getItem(k);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(k, id);
  }
  return id;
}

function toApiMessages(messages: any[]) {
  return messages.map((m: any) => ({
    role: m.role === "ai" ? "assistant" : "user",
    content: m.text ?? m.message ?? "",
  }));
}

export default function ChatWidget({ history, demo = false }: Props) {
  const theme = useTheme();
  const { session, endAndExit, participantId, currentTaskCode } = useFlow(); // ⬅️ get token (and exit helper)
  const convIdRef = useRef<string | undefined>(undefined); // ⬅️ persist conversation_id across turns

  const bg = theme.palette.background.default;
  const bubbleAI = theme.palette.mode === "dark" ? "#545454" : "#f5f5f5";
  const textAI = theme.palette.mode === "dark" ? "white" : "#111";
  const bubbleUser = theme.palette.primary.main;
  const textUser = theme.palette.getContrastText(theme.palette.primary.main);

  /** Send to /chat/messages via Caddy — disabled if demo is set */
  const connect = useMemo(
    () =>
      demo
        ? undefined
        : {
            url: `${CHAT_BASE}/messages`,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              // ⬇️ inject token if present; requestInterceptor also re-injects (for rotations)
              ...(session?.token ? { "X-Session-Write-Token": session.token } : {}),
            },
            additionalBodyProps: {
              user_id: participantId,
              streaming: false,
              // ⬇️ pass the current conversation id if we have one
              conversation_id: convIdRef.current ?? null,
              task_code: currentTaskCode,
            },
          },
    [demo, session?.token]
  );

  /** Map Deep Chat body -> your API body and (re)inject auth header each time */
  const requestInterceptor = useCallback(
    (req: any) => {
      if (demo) return req; // no-op in demo mode
      const src = req.body?.messages ?? [];
      const mapped = toApiMessages(src);

      // Re-attach token on every request (covers token refresh / memoization issues)
      const headers = {
        ...(req.headers || {}),
        ...(session?.token ? { "X-Session-Write-Token": session.token } : {}),
      };

      // Thread conversation_id to keep the same DB conversation
      const body = {
        ...req.body,
        messages: mapped,
        conversation_id: convIdRef.current ?? null,
      };

      return { ...req, headers, body };
    },
    [demo, session?.token]
  );

  /** Map your API response -> Deep Chat Response; capture conversation_id */
  const responseInterceptor = useCallback(
    (res: any) => {
      if (demo) return res;
      if (res?.conversation_id) convIdRef.current = res.conversation_id;
      return { text: res?.reply ?? "" };
    },
    [demo]
  );

  // Optional: basic 401 handling if DeepChat exposes an error hook
  // @ts-ignore – only if DeepChat supports onResponseError
  const onResponseError = useCallback(
    async (err: any) => {
      if (err?.status === 401 || err?.status === 403) {
        await endAndExit("session_invalid");
      }
    },
    [endAndExit]
  );

  const requestBodyLimits = { maxMessages: 20 };

  const messageStyles: any = {
    default: {
      ai: { bubble: { backgroundColor: bubbleAI, color: textAI } },
      user: { bubble: { backgroundColor: bubbleUser, color: textUser } },
    },
    loading: { bubble: { backgroundColor: bubbleAI, color: textAI } },
  };

  const textInput: any = {
    styles: {
      container: {
        backgroundColor: theme.palette.mode === "dark" ? "#666666" : "#fff",
        border: "unset",
        color: theme.palette.text.primary,
      },
    },
    placeholder: { text: "Ask me anything!", style: { color: theme.palette.text.disabled } },
  };

  const submitButtonStyles: any = {
    submit: {
      container: { default: { bottom: "0.7rem" } },
      svg: {
        styles: {
          default: {
            filter:
              "brightness(0) saturate(100%) invert(70%) sepia(52%) saturate(5617%) hue-rotate(185deg) brightness(101%) contrast(101%)",
          },
        },
      },
    },
  };

  const auxiliaryStyle = `
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-thumb { background-color: ${theme.palette.grey[600]}; border-radius: 5px; }
    ::-webkit-scrollbar-track { background-color: transparent; }
  `;

  return (
    <Card sx={{ height: 1, minHeight: 0, display: "flex", bgcolor: "transparent" }}>
      <DeepChat
        style={{ width: "100%", height: "100%", backgroundColor: "#292929", borderRadius: 12, border: "none" }}
        demo={demo}
        history={history}
        messageStyles={messageStyles}
        textInput={textInput}
        submitButtonStyles={submitButtonStyles}
        auxiliaryStyle={auxiliaryStyle}
        connect={connect as any}
        requestInterceptor={requestInterceptor as any}
        responseInterceptor={responseInterceptor as any}
        requestBodyLimits={requestBodyLimits}
        // @ts-ignore – only if supported by your DeepChat version
        onResponseError={onResponseError}
      />
    </Card>
  );
}
