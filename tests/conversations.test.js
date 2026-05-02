import { strict as assert } from "assert";
import { createApp } from "../src/server.ts";

describe("conversations routes", function () {
	let server;
	let baseUrl;

	before(function (done) {
		const app = createApp();
		server = app.listen(0, () => {
			const address = server.address();
			baseUrl = `http://127.0.0.1:${address.port}`;
			done();
		});
	});

	after(function (done) {
		server.close(done);
	});

	const headers = {
		authorization: "Bearer test-key",
		"content-type": "application/json",
	};

	it("creates, updates, lists items, deletes an item, and deletes a conversation", async function () {
		const createResponse = await fetch(`${baseUrl}/v1/conversations`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				metadata: { topic: "test" },
				items: [{ type: "message", role: "user", content: "hello" }],
			}),
		});
		assert.equal(createResponse.status, 200);
		const conversation = await createResponse.json();
		assert.match(conversation.id, /^conv_/);
		assert.equal(conversation.object, "conversation");
		assert.deepEqual(conversation.metadata, { topic: "test" });

		const updateResponse = await fetch(`${baseUrl}/v1/conversations/${conversation.id}`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				metadata: { topic: "updated" },
			}),
		});
		assert.equal(updateResponse.status, 200);
		const updatedConversation = await updateResponse.json();
		assert.deepEqual(updatedConversation.metadata, { topic: "updated" });

		const appendResponse = await fetch(`${baseUrl}/v1/conversations/${conversation.id}/items`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }],
			}),
		});
		assert.equal(appendResponse.status, 200);
		const appended = await appendResponse.json();
		assert.equal(appended.object, "list");
		assert.equal(appended.data.length, 1);
		assert.ok(appended.data[0].id);

		const listResponse = await fetch(`${baseUrl}/v1/conversations/${conversation.id}/items`, { headers });
		assert.equal(listResponse.status, 200);
		const list = await listResponse.json();
		assert.equal(list.object, "list");
		assert.equal(list.data.length, 2);
		assert.equal(list.has_more, false);

		const itemId = appended.data[0].id;
		const itemResponse = await fetch(`${baseUrl}/v1/conversations/${conversation.id}/items/${itemId}`, { headers });
		assert.equal(itemResponse.status, 200);
		const item = await itemResponse.json();
		assert.equal(item.id, itemId);

		const deleteItemResponse = await fetch(`${baseUrl}/v1/conversations/${conversation.id}/items/${itemId}`, {
			method: "DELETE",
			headers,
		});
		assert.equal(deleteItemResponse.status, 200);
		assert.deepEqual(await deleteItemResponse.json(), {
			id: itemId,
			object: "conversation.item.deleted",
			deleted: true,
		});

		const deleteConversationResponse = await fetch(`${baseUrl}/v1/conversations/${conversation.id}`, {
			method: "DELETE",
			headers,
		});
		assert.equal(deleteConversationResponse.status, 200);
		assert.deepEqual(await deleteConversationResponse.json(), {
			id: conversation.id,
			object: "conversation.deleted",
			deleted: true,
		});
	});

	it("returns 404 for unknown response state references before contacting upstream", async function () {
		const previousResponse = await fetch(`${baseUrl}/v1/responses`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: "test-model",
				previous_response_id: "resp_missing",
			}),
		});
		assert.equal(previousResponse.status, 404);

		const conversationResponse = await fetch(`${baseUrl}/v1/responses`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: "test-model",
				conversation: "conv_missing",
			}),
		});
		assert.equal(conversationResponse.status, 404);
	});
});
