#!/usr/bin/env python3

import sys
from pathlib import Path

from reportlab.pdfgen import canvas


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: generate-pdf-attachment.py <output.pdf>")

    output = Path(sys.argv[1])
    output.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(
        str(output),
        pagesize=(300, 144),
        invariant=1,
        pageCompression=0,
    )
    pdf.setTitle("FG-06 PDF Attachment")
    pdf.setFont("Helvetica-Bold", 18)
    pdf.drawString(30, 84, "PDF-ATTACHMENT-5C21")
    pdf.setFont("Helvetica", 9)
    pdf.drawString(30, 62, "Deterministic Feishu attachment fixture")
    pdf.showPage()
    pdf.save()


if __name__ == "__main__":
    main()
