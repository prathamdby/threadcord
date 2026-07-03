import { MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { DiscordPublisher } from "../src/discord/publisher.js";
import type { ViewPayload } from "../src/discord/ui/index.js";

const IS_COMPONENTS_V2 = 32768;

function viewPayload(): ViewPayload {
  return { components: [], flags: MessageFlags.IsComponentsV2 };
}

describe("DiscordPublisher view methods", () => {
  it("sendView posts a CV2 payload to the thread channel", async () => {
    const send = vi.fn().mockResolvedValue({ id: "msg-1" });
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          isSendable: () => true,
          send,
        }),
      },
    };
    const publisher = new DiscordPublisher(client as never);
    const payload = viewPayload();

    const result = await publisher.sendView("thread-1", payload);

    expect(result).toEqual({ id: "msg-1" });
    expect(send).toHaveBeenCalledWith(payload);
  });

  it("editView updates an existing message with a CV2 payload", async () => {
    const edit = vi.fn().mockResolvedValue(undefined);
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          isTextBased: () => true,
          messages: {
            fetch: vi.fn().mockResolvedValue({ edit }),
          },
        }),
      },
    };
    const publisher = new DiscordPublisher(client as never);
    const payload = viewPayload();

    await publisher.editView("thread-1", "msg-9", payload);

    expect(edit).toHaveBeenCalledWith(payload);
  });
});
