import * as fs from "fs/promises";
import os from "os";
import path from "path";
import { App, TFile } from "obsidian";
import pLimit from "p-limit";

type ImageType = "webp" | "png" | "jpeg";

type RenderResult = {
  imageSrc: string;
  filePath: string;
};

type ReplacePdfEmbedsOptions = {
  app: App;
  doc: Document;
  sourceFile: TFile;
  pdfjsLib: any;
  tempDir: string;
  scale?: number;
  imageType?: ImageType;
  concurrency?: number;
};

const PDF_EXT = /\.pdf$/i;

function sanitizeForFilename(input: string) {
  return encodeURIComponent(input).replace(/%/g, "_");
}

function parsePageFromFragment(fragment: string) {
  const query = fragment.replace(/^#/, "");
  const params = new URLSearchParams(query);
  const page = Number(params.get("page") ?? "1");
  if (!Number.isFinite(page) || page < 1) {
    return 1;
  }
  return Math.floor(page);
}

export function parsePdfEmbed(src: string) {
  const trimmed = src.trim();
  const [rawPath, ...fragmentParts] = trimmed.split("#");
  const linktext = decodeURIComponent(rawPath ?? "").trim();
  const fragment = fragmentParts.join("#");
  const page = fragment.length > 0 ? parsePageFromFragment(fragment) : 1;
  return { linktext, page };
}

function getEmbedSource(el: Element) {
  return (
    el.getAttribute("src") ??
    el.getAttribute("data-src") ??
    el.getAttribute("data-href") ??
    el.getAttribute("data")
  );
}

function looksLikePdfSource(src: string) {
  const [filePart] = src.split("#");
  return PDF_EXT.test(filePart);
}

function getImageMime(imageType: ImageType) {
  return `image/${imageType}` as const;
}

function getImageExt(imageType: ImageType) {
  return imageType === "jpeg" ? "jpg" : imageType;
}

async function blobFromCanvas(canvas: HTMLCanvasElement, imageType: ImageType) {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Failed to create image blob"));
          return;
        }
        resolve(blob);
      },
      getImageMime(imageType),
      imageType === "png" ? undefined : 0.9,
    );
  });
}

async function blobToDataUrl(blob: Blob) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Failed to convert blob to data URL"));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read blob"));
    reader.readAsDataURL(blob);
  });
}

function resolvePdfFile(app: App, sourceFile: TFile, linktext: string) {
  const linkedFile = app.metadataCache.getFirstLinkpathDest(linktext, sourceFile.path);
  if (linkedFile instanceof TFile && PDF_EXT.test(linkedFile.path)) {
    return linkedFile;
  }
  const abstract = app.vault.getAbstractFileByPath(linktext);
  if (abstract instanceof TFile && PDF_EXT.test(abstract.path)) {
    return abstract;
  }
  return null;
}

async function renderPdfPageToTempImage(
  app: App,
  pdfjsLib: any,
  file: TFile,
  page: number,
  tempDir: string,
  scale: number,
  imageType: ImageType,
): Promise<RenderResult> {
  const fileBytes = await app.vault.readBinary(file);
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(fileBytes) });
  const pdf = await loadingTask.promise;
  let pdfPage: any;
  const canvas = document.createElement("canvas");
  try {
    const safePage = Math.max(1, Math.min(page, pdf.numPages));
    pdfPage = await pdf.getPage(safePage);
    const viewport = pdfPage.getViewport({ scale });

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Failed to create canvas context");
    }
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    await pdfPage.render({ canvasContext: context, viewport }).promise;
    const blob = await blobFromCanvas(canvas, imageType);
    const imageSrc = await blobToDataUrl(blob);
    const outBuffer = new Uint8Array(await blob.arrayBuffer());

    const nameBase = sanitizeForFilename(`${file.path}|page:${safePage}|scale:${scale}`);
    const imagePath = path.join(tempDir, `${nameBase}.${getImageExt(imageType)}`);
    await fs.writeFile(imagePath, outBuffer);
    return {
      filePath: imagePath,
      imageSrc,
    };
  } finally {
    if (pdfPage) {
      pdfPage.cleanup();
    }
    canvas.width = 0;
    canvas.height = 0;
    pdf.cleanup();
  }
}

function toImageElement(doc: Document, sourceEl: Element, src: string) {
  const img = doc.createElement("img");
  img.setAttribute("src", src);
  const className = sourceEl.getAttribute("class");
  if (className) {
    img.className = className;
  }
  img.setAttribute("style", "max-width: 100%; height: auto;");
  return img;
}

export async function createTempPdfRenderDir() {
  const root = path.join(os.tmpdir(), "better-export-pdf");
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, "export-"));
}

export async function removeTempPaths(paths: string[]) {
  await Promise.allSettled(paths.map((item) => fs.rm(item, { recursive: true, force: true })));
}

export async function replaceEmbeddedPdfsWithImages({
  app,
  doc,
  sourceFile,
  pdfjsLib,
  tempDir,
  scale = 1.5,
  imageType = "webp",
  concurrency = 3,
}: ReplacePdfEmbedsOptions) {
  const nodes = Array.from(
    doc.querySelectorAll(".internal-embed[src], iframe[src], embed[src], object[data], span.markdown-embed"),
  );
  if (nodes.length === 0) {
    return;
  }

  const cache = new Map<string, Promise<RenderResult>>();
  const limit = pLimit(Math.max(1, concurrency));

  await Promise.all(
    nodes.map((node) =>
      limit(async () => {
        const source = getEmbedSource(node);
        if (!source || !looksLikePdfSource(source)) {
          return;
        }

        const { linktext, page } = parsePdfEmbed(source);
        const file = resolvePdfFile(app, sourceFile, linktext);
        if (!file) {
          return;
        }

        const key = `${file.path}|${page}|${scale}|${imageType}`;
        if (!cache.has(key)) {
          cache.set(key, renderPdfPageToTempImage(app, pdfjsLib, file, page, tempDir, scale, imageType));
        }

        const result = await cache.get(key);
        if (!result) {
          return;
        }
        node.replaceWith(toImageElement(doc, node, result.imageSrc));
      }),
    ),
  );
}
