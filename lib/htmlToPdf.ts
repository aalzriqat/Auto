/**
 * Converts a hidden, print-styled DOM element (id={elementId}) into a
 * single-page A4 PDF and triggers a browser download. Shared by every
 * HTML-based document template in the app (quotes, receipt vouchers, ...)
 * so the html2canvas/jsPDF plumbing lives in exactly one place.
 */
export async function downloadElementAsPdf(elementId: string, filename: string): Promise<boolean> {
  const element = document.getElementById(elementId);
  if (!element) return false;

  try {
    element.classList.remove("hidden");
    element.style.position = "absolute";
    element.style.left = "-9999px";
    element.style.top = "-9999px";
    element.style.display = "block";

    const { default: html2canvas } = await import("html2canvas");
    const { jsPDF } = await import("jspdf");

    const canvas = await html2canvas(element, { scale: 2, useCORS: true });
    const imgData = canvas.toDataURL("image/png");
    const pdf = new jsPDF("p", "mm", "a4");
    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
    pdf.addImage(imgData, "PNG", 0, 0, pdfWidth, pdfHeight);
    pdf.save(filename);
    return true;
  } catch {
    return false;
  } finally {
    element.style.display = "";
    element.style.position = "";
    element.style.left = "";
    element.style.top = "";
    element.classList.add("hidden");
  }
}
