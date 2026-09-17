import { Box, Typography } from "@mui/material";
import ChatWidget from "../components/ChatWidget";

type Props = { demo?: boolean };

export default function ChatPage({ demo = false }: Props) {
  return (
    <Box sx={{ height: 1, minHeight: 0, display: "flex", flexDirection: "column", px: 2, py: 3 }}>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <ChatWidget />
      </Box>
    </Box>
  );
}
