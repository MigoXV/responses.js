import { strict as assert } from "assert";
import { InMemoryStateStore, getStateTtlSeconds } from "../src/lib/stateStore.ts";

describe("InMemoryStateStore", function () {
	it("uses the configured TTL and expires conversations plus response histories", function () {
		const store = new InMemoryStateStore(1);
		const conversation = store.createConversation({
			items: [{ type: "message", role: "user", content: "hello" }],
		});
		store.storeResponseHistory("resp_test", [{ type: "message", role: "user", content: "hello" }]);

		assert.ok(store.getConversation(conversation.id));
		assert.ok(store.getResponseHistory("resp_test"));

		store.cleanupExpired(conversation.created_at + 2);

		assert.equal(store.getConversation(conversation.id), undefined);
		assert.equal(store.getResponseHistory("resp_test"), undefined);
		store.dispose();
	});

	it("keeps state forever when TTL is zero or negative", function () {
		const store = new InMemoryStateStore(0);
		const conversation = store.createConversation({
			items: [{ type: "message", role: "user", content: "hello" }],
		});
		store.storeResponseHistory("resp_test", [{ type: "message", role: "user", content: "hello" }]);

		store.cleanupExpired(conversation.created_at + 999_999);

		assert.ok(store.getConversation(conversation.id));
		assert.ok(store.getResponseHistory("resp_test"));
		store.dispose();
	});

	it("normalizes stored item ids and statuses", function () {
		const store = new InMemoryStateStore(300);
		const conversation = store.createConversation({
			items: [
				{
					type: "function_call",
					call_id: "call_1",
					name: "get_weather",
					arguments: "{}",
				},
			],
		});

		const items = store.listConversationItems(conversation.id);

		assert.equal(items?.length, 1);
		assert.equal(items?.[0].type, "function_call");
		assert.equal(items?.[0].status, "completed");
		assert.ok(items?.[0].id);
		store.dispose();
	});

	it("parses TTL configuration with the documented defaults", function () {
		assert.equal(getStateTtlSeconds(undefined), 300);
		assert.equal(getStateTtlSeconds("10"), 10);
		assert.equal(getStateTtlSeconds("0"), 0);
		assert.equal(getStateTtlSeconds("-1"), -1);
		assert.equal(getStateTtlSeconds("not-a-number"), 300);
	});
});
