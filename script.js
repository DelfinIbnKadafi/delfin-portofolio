const $ = selector => document.querySelector(selector);

function arrangeProjects(projectList) {
  const cards = [...projectList.querySelectorAll(".project-card")];
  const desktop = window.matchMedia("(min-width: 601px)");
  let frame = 0;

  // Keep the next card close to the one above it
  function layoutProjects() {
    projectList.classList.toggle("is-staggered", desktop.matches);

    if (!desktop.matches) {
      cards.forEach(card => {
        card.style.removeProperty("grid-column");
        card.style.removeProperty("grid-row");
      });
      return;
    }

    const style = getComputedStyle(projectList);
    const gap = parseFloat(style.getPropertyValue("--project-gap"));
    const step = parseFloat(style.getPropertyValue("--project-step"));
    const heights = cards.map(card => Math.ceil(card.getBoundingClientRect().height));
    const bottoms = [0, 0];
    let previousTop = -step;

    cards.forEach((card, index) => {
      const column = index % 2;
      const top = Math.max(bottoms[column], previousTop + step);
      card.style.gridColumn = String(column + 1);
      card.style.gridRow = `${top + 1} / span ${heights[index]}`;
      bottoms[column] = top + heights[index] + gap;
      previousTop = top;
    });
  }

  function scheduleLayout() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      layoutProjects();
    });
  }

  const observer = new ResizeObserver(scheduleLayout);
  observer.observe(projectList);
  cards.forEach(card => observer.observe(card));
  desktop.addEventListener("change", scheduleLayout);
  layoutProjects();
}

async function loadPortfolio() {
  const response = await fetch("./data/data.json");

  if (!response.ok) {
    throw new Error(`JSON request failed: ${response.status}`);
  }

  const data = await response.json();
  const profile = data.profile;

  document.title = `${profile.name} — Developer Portfolio`;

  $("#eyebrow").textContent = profile.eyebrow ?? "";
  $("#hero-title").textContent = profile.title ?? "";
  $("#hero-description").textContent = profile.description ?? "";
  $("#location").textContent = profile.location ?? "";
  $("#hero-github").href = profile.github ?? "#";
  $("#contact-email").href = profile.email
    ? `mailto:${profile.email}`
    : "#";
  $("#year").textContent = new Date().getFullYear();

  if (profile.portrait) {
    $("#hero-image").src = profile.portrait;
  }

  // Render project cards
  const projectList = $("#project-list");
  projectList.replaceChildren();

  (data.projects ?? []).forEach((project, index) => {
    const card = document.createElement("article");
    card.className = `project-card project-${index % 2 + 1}`;

    const imageLink = document.createElement("a");
    imageLink.className = "project-image";
    imageLink.href = project.url || "#";
    imageLink.target = "_blank";
    imageLink.rel = "noopener noreferrer";
    imageLink.setAttribute("aria-label", `View ${project.name}`);

    const image = document.createElement("img");
    image.src = project.image || "";
    image.alt = `Illustration for ${project.name}`;
    image.loading = "lazy";
    image.decoding = "async";

    const imageArrow = document.createElement("span");
    imageArrow.className = "image-arrow";
    imageArrow.textContent = "↗";

    imageLink.append(image, imageArrow);

    const details = document.createElement("div");
    details.className = "project-details";

    const category = document.createElement("p");
    category.className = "project-category";
    category.textContent = project.category ?? "";

    const title = document.createElement("h3");
    const titleLink = document.createElement("a");
    titleLink.className = "project-title";
    titleLink.href = imageLink.href;
    titleLink.target = "_blank";
    titleLink.rel = "noopener noreferrer";
    titleLink.textContent = project.name ?? "Untitled Project";
    title.append(titleLink);

    const description = document.createElement("p");
    description.className = "project-description";
    description.textContent = project.description ?? "";

    const footer = document.createElement("div");
    footer.className = "project-footer";

    const language = document.createElement("span");
    language.className = "project-language";
    language.textContent = project.language ?? "";

    const status = document.createElement("span");
    status.className = "project-status";
    status.textContent = project.status ?? "";

    footer.append(language, status);
    details.append(category, title, description, footer);
    card.append(imageLink, details);
    projectList.append(card);
  });

  arrangeProjects(projectList);

  // Render social links
  const socialList = $("#social-list");
  socialList.replaceChildren();

  (data.socials ?? []).forEach(social => {
    const link = document.createElement("a");
    link.className = "social-link";
    link.href = social.url || "#";

    if (social.url && !social.url.startsWith("mailto:")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }

    const icon = document.createElement("img");
    icon.className = "social-icon";
    icon.src = social.icon || "";
    icon.alt = "";
    icon.setAttribute("aria-hidden", "true");
    icon.width = 24;
    icon.height = 24;
    icon.loading = "lazy";

    icon.onerror = () => {
      icon.style.display = "none";
    };

    const info = document.createElement("div");
    info.className = "social-info";

    const name = document.createElement("strong");
    name.textContent = social.name ?? "Social Link";

    const detail = document.createElement("span");
    detail.textContent = social.detail ?? social.description ?? "";

    const arrow = document.createElement("span");
    arrow.className = "social-arrow";
    arrow.textContent = "↗";

    info.append(name, detail);
    link.append(icon, info, arrow);
    socialList.append(link);
  });
}

loadPortfolio().catch(error => {
  console.error("Portfolio loading error:", error);

  $("#project-list").textContent =
    "Unable to load projects. Check data/data.json.";

  $("#social-list").textContent =
    "Unable to load social links.";
});
