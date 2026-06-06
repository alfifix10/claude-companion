// FAQ accordion — keep only one answer open at a time.
document.querySelectorAll(".faq details").forEach((d) => {
  d.addEventListener("toggle", () => {
    if (!d.open) return;
    document.querySelectorAll(".faq details[open]").forEach((o) => {
      if (o !== d) o.open = false;
    });
  });
});
