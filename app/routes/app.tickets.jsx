import { Form, useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import {
  listSupportTickets,
  updateSupportTicketStatus,
  deleteSupportTicket,
} from "../db.server";

const TICKET_TYPE_LABELS = {
  return: "Return",
  refund: "Refund",
  cancel_order: "Order cancellation",
  modify_order: "Order modification",
  warranty: "Warranty",
  callback: "Callback",
  escalation: "Escalation",
};

const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"];

const STATUS_LABELS = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
};

export async function loader({ request }) {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "";

  const tickets = await listSupportTickets(status || undefined);

  return {
    tickets,
    status,
    labels: { TICKET_TYPE_LABELS, STATUS_LABELS },
  };
}

export async function action({ request }) {
  await authenticate.admin(request);

  const formData = await request.formData();
  const ticketId = String(formData.get("ticket_id") || "");
  const intent = String(formData.get("intent") || "");

  if (ticketId && intent === "delete") {
    await deleteSupportTicket(ticketId);
  } else if (ticketId && intent === "status") {
    const status = String(formData.get("status") || "");
    if (TICKET_STATUSES.includes(status)) {
      await updateSupportTicketStatus(ticketId, status);
    }
  }

  const url = new URL(request.url);
  const currentStatus = url.searchParams.get("status") || "";
  const redirectTarget = currentStatus
    ? `/app/tickets?status=${encodeURIComponent(currentStatus)}`
    : "/app/tickets";

  return new Response(null, {
    status: 303,
    headers: { Location: redirectTarget },
  });
}

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n) => (n < 10 ? "0" : "") + n;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function Tickets() {
  const { tickets, status, labels } = useLoaderData();
  const [, setSearchParams] = useSearchParams();

  return (
    <s-page>
      <ui-title-bar title="Support tickets" />

      <s-section>
        <s-stack gap="base">
          <s-heading>
            Customer support requests
            {status ? ` — ${labels.STATUS_LABELS[status] || status}` : ""}
          </s-heading>
          <s-paragraph>
            Tickets are created by the AI chat assistant when a customer requests
            a callback, asks to speak with a human, or submits a support/after-sale
            request. Callback requests show the contact details and preferred time
            the customer entered in the form.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section>
        <label htmlFor="status-filter" style={{ fontWeight: 600 }}>
          Filter by status
        </label>
        <select
          id="status-filter"
          name="status"
          value={status}
          onChange={(e) => {
            const value = e.target.value;
            setSearchParams(value ? { status: value } : {});
          }}
          style={{ marginLeft: 8, padding: "6px 10px" }}
        >
          <option value="">All statuses</option>
          {TICKET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {labels.STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </s-section>

      <s-section padding={tickets.length === 0 ? undefined : "none"}>
        {tickets.length === 0 ? (
          <s-paragraph>
            No support tickets yet. When a customer fills the callback form or
            requests human support in the chat, the request appears here.
          </s-paragraph>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                minWidth: 900,
                borderCollapse: "collapse",
                fontSize: "14px",
              }}
            >
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <th style={thStyle}>Created</th>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Summary</th>
                  <th style={thStyle}>Customer / contact</th>
                  <th style={thStyle}>Callback time</th>
                  <th style={thStyle}>Conversation</th>
                  <th style={thStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((ticket) => (
                  <tr key={ticket.id} style={{ borderTop: "1px solid #e3e3e3" }}>
                    <td style={tdStyle}>{formatDate(ticket.createdAt)}</td>
                    <td style={tdStyle}>
                      {labels.TICKET_TYPE_LABELS[ticket.type] || ticket.type}
                    </td>
                    <td style={tdStyle}>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "2px 8px",
                          borderRadius: "999px",
                          fontSize: "12px",
                          fontWeight: 600,
                          background:
                            ticket.status === "open"
                              ? "#ffece5"
                              : ticket.status === "in_progress"
                                ? "#fff3cd"
                                : ticket.status === "resolved"
                                  ? "#e3f1df"
                                  : "#ececec",
                        }}
                      >
                        {labels.STATUS_LABELS[ticket.status] || ticket.status}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, maxWidth: 260 }}>
                      <div
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: 260,
                        }}
                        title={ticket.summary || ""}
                      >
                        {ticket.summary || "—"}
                      </div>
                    </td>
                    <td style={tdStyle}>
                      <div>
                        {[ticket.customerName, ticket.customerEmail]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </div>
                      {(ticket.contactPhone || ticket.orderRef) && (
                        <div style={{ fontSize: "12px", color: "#666", marginTop: 2 }}>
                          {[ticket.contactPhone, ticket.orderRef ? `Order ${ticket.orderRef}` : ""]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      )}
                    </td>
                    <td style={tdStyle}>
                      {ticket.callTime ? formatDate(ticket.callTime) : "—"}
                    </td>
                    <td style={tdStyle}>
                      {ticket.conversationId ? (
                        <code
                          style={{ fontSize: "12px" }}
                          title={ticket.conversationId}
                        >
                          {String(ticket.conversationId).slice(0, 12)}
                        </code>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                      <div
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          flexWrap: "wrap",
                        }}
                      >
                        <Form method="post" style={{ display: "inline-flex", gap: 4 }}>
                          <input type="hidden" name="ticket_id" value={ticket.id} />
                          <input type="hidden" name="intent" value="status" />
                          <select
                            name="status"
                            defaultValue={ticket.status}
                            style={{ padding: "4px 6px", fontSize: "13px" }}
                          >
                            {TICKET_STATUSES.map((s) => (
                              <option key={s} value={s}>
                                {labels.STATUS_LABELS[s]}
                              </option>
                            ))}
                          </select>
                          <button
                            type="submit"
                            style={{
                              padding: "4px 10px",
                              fontSize: "13px",
                              cursor: "pointer",
                            }}
                          >
                            Save
                          </button>
                        </Form>
                        <Form
                          method="post"
                          onSubmit={(e) => {
                            if (
                              !window.confirm(
                                "Delete this support ticket? This cannot be undone."
                              )
                            ) {
                              e.preventDefault();
                            }
                          }}
                        >
                          <input type="hidden" name="ticket_id" value={ticket.id} />
                          <input type="hidden" name="intent" value="delete" />
                          <button
                            type="submit"
                            style={{
                              padding: "4px 10px",
                              fontSize: "13px",
                              cursor: "pointer",
                              color: "#b3231e",
                            }}
                          >
                            Delete
                          </button>
                        </Form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </s-section>
    </s-page>
  );
}

const thStyle = {
  padding: "8px 10px",
  borderBottom: "2px solid #e3e3e3",
  whiteSpace: "nowrap",
};

const tdStyle = {
  padding: "8px 10px",
  verticalAlign: "top",
};