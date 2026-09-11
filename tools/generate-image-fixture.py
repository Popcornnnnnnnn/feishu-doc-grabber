#!/usr/bin/env python3

from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


ROOT = Path(__file__).resolve().parent.parent
MEDIA = ROOT / "tests" / "generated" / "media"
OUTPUT = ROOT / "tests" / "generated" / "FG-05 Images.docx"


def style_text(style, *, size=None, bold=None):
    style.font.name = "Arial"
    style._element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), "Arial")
    style.font.color.rgb = RGBColor(0, 0, 0)
    if size is not None:
        style.font.size = Pt(size)
    if bold is not None:
        style.font.bold = bold
    properties = style._element.get_or_add_pPr()
    border = properties.find(qn("w:pBdr"))
    if border is not None:
        properties.remove(border)


def add_figure(doc, heading, source, width, alt_text, caption_text=None):
    doc.add_heading(heading, level=1)
    paragraph = doc.add_paragraph()
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    shape = paragraph.add_run().add_picture(str(source), width=Inches(width))
    shape._inline.docPr.set("descr", alt_text)
    shape._inline.docPr.set("title", alt_text)
    caption = doc.add_paragraph()
    caption.alignment = WD_ALIGN_PARAGRAPH.CENTER
    caption.style = doc.styles["Caption"]
    caption.add_run(caption_text or alt_text)


doc = Document()
section = doc.sections[0]
section.page_width = Inches(8.5)
section.page_height = Inches(11)
section.top_margin = Inches(0.7)
section.bottom_margin = Inches(0.7)
section.left_margin = Inches(0.8)
section.right_margin = Inches(0.8)

for style_name in ["Title", "Heading 1", "Heading 2", "Caption"]:
    style_text(doc.styles[style_name])
style_text(doc.styles["Normal"], size=11)

title = doc.add_paragraph(style="Title")
title.add_run("FG 05 Images")
doc.add_paragraph(
    "This fixture verifies five distinct Feishu image blocks, duplicate source handling, source format conversion, "
    "Unicode descriptions, and a large image."
)
doc.add_paragraph("IMAGE-TOP-A62C")

add_figure(doc, "Small PNG", MEDIA / "fixture-small.png", 1.5, "fixture-small PNG 96 by 64")
add_figure(doc, "JPEG photo pattern", MEDIA / "fixture-photo.jpg", 4.8, "fixture-photo JPEG 640 by 360")
add_figure(
    doc,
    "SVG source raster fallback",
    MEDIA / "fixture-vector.png",
    4.8,
    "fixture-vector SVG source imported through DOCX raster fallback",
)
add_figure(doc, "Duplicate PNG", MEDIA / "fixture-small.png", 1.5, "fixture-small duplicate source")
add_figure(
    doc,
    "Large Unicode image",
    MEDIA / "fixture-large.png",
    6.2,
    "图片 大图 Ω 2200 by 1400",
    "Unicode alt text Ω 2200 by 1400",
)

doc.add_paragraph("Final sentinel IMAGE-END-B8E4")

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
doc.save(OUTPUT)
print(OUTPUT)
