import { bindStateUi, loadSettings, requestId, sendCommand } from "./ui-common.js";

const root = document.body;
const ui = bindStateUi({ root });

async function init(): Promise<void> {
  const { state } = await loadSettings();
  ui.render(state);

  const reply = await sendCommand({ type: "GET_STATE", requestId: requestId() });
  if (reply.state) ui.render(reply.state);

  document.querySelector("#btn-stop")?.addEventListener("click", async () => {
    const stopReply = await sendCommand({
      type: "STOP_ALL",
      requestId: requestId(),
    });
    if (stopReply.state) ui.render(stopReply.state);
  });
}

void init();
