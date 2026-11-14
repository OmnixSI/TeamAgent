// The list of skills. Each lives in its own file and is wired in here once.
import type { Skill } from "./types.ts";
import doc_to_pdf from "./doc-to-pdf.ts";
import pdf_tools from "./pdf-tools.ts";
import pdf_to_docx from "./pdf-to-docx.ts";
import pdf_to_markdown from "./pdf-to-markdown.ts";
import pdf_ocr from "./pdf-ocr.ts";
import md_to_report from "./md-to-report.ts";
import md_to_slides from "./md-to-slides.ts";
import resume from "./resume.ts";
import image_batch from "./image-batch.ts";
import image_collage from "./image-collage.ts";
import media_convert from "./media-convert.ts";
import qr_code from "./qr-code.ts";

export const SKILLS: Skill[] = ([doc_to_pdf, pdf_tools, pdf_to_docx, pdf_to_markdown, pdf_ocr, md_to_report, md_to_slides, resume, image_batch, image_collage, media_convert, qr_code] as (Skill | null)[]).filter((s): s is Skill => !!s);
