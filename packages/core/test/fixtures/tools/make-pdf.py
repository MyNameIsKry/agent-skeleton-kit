"""Regenerates tenants/valid/fixture-alpha/knowledge/onboarding-checklist.pdf:

    python3 packages/core/test/fixtures/tools/make-pdf.py > packages/core/test/fixtures/tenants/valid/fixture-alpha/knowledge/onboarding-checklist.pdf

Writes a minimal, valid, text-based PDF with one text block per page (Helvetica, WinAnsi)."""
import sys


def make_pdf(pages: list[list[str]]) -> bytes:
    objects: list[bytes] = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    pages_id_placeholder = len(objects) + 1
    add(b"")  # pages object, filled in below
    page_ids = []
    for lines in pages:
        ops = ["BT", "/F1 12 Tf", "14 TL", "72 720 Td"]
        for line in lines:
            escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            ops.append(f"({escaped}) Tj T*")
        ops.append("ET")
        stream = "\n".join(ops).encode("latin-1")
        content = add(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
        page = add(
            b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>"
            % (pages_id_placeholder, font, content)
        )
        page_ids.append(page)
    kids = " ".join(f"{p} 0 R" for p in page_ids).encode()
    objects[pages_id_placeholder - 1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (kids, len(page_ids))
    catalog = add(b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id_placeholder)
    info = add(b"<< /Producer (agent-skeleton-kit test fixture) >>")

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        catalog,
        info,
        xref,
    )
    return bytes(out)


if __name__ == "__main__":
    pages = [
        ["Alpha onboarding checklist", "Day one: collect your laptop from the IT desk.", "Day one: enable two-factor authentication."],
        ["Week one", "Meet your onboarding buddy and read the alpha handbook."],
    ]
    sys.stdout.buffer.write(make_pdf(pages))
