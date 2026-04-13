document.addEventListener("DOMContentLoaded", async () => {
  try {
    const res = await fetch("https://api.github.com/repos/lklynet/aurral");
    if (!res.ok) return;

    const data = await res.json();
    if (data.stargazers_count !== undefined) {
      const formattedStars = new Intl.NumberFormat("en-US").format(
        data.stargazers_count,
      );

      document.querySelectorAll(".github-stars-count").forEach((el) => {
        el.textContent = formattedStars;
      });

      document.querySelectorAll(".github-stars-badge").forEach((el) => {
        el.style.display = "inline-flex";
      });
    }
  } catch (error) {
    console.error("Failed to fetch GitHub stars:", error);
  }
});
