export type ContactFormType = "enquiry" | "booking" | "site-visit";

export async function submitContact(
  type: ContactFormType,
  fields: Record<string, string | boolean>,
) {
  const response = await fetch("/api/contact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, ...fields }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(result?.error || "Unable to send your request. Please try again or email info@sampangroup.com.bd.");
  }
}
