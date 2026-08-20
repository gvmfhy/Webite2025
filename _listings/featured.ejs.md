```{=html}
<div class="list featured-list">
<% for (let i = 0; i < items.length; i++) { const item = items[i]; %>
  <a href="<%- item.path %>" class="quarto-post featured-card no-external" <%= metadataAttrs(item) %>>
    <span class="featured-card__number" aria-hidden="true"><%= (i + 1).toString().padStart(2, "0") %></span>
    <span class="featured-card__body">
      <span class="listing-title"><%= item.title %></span>
      <% if (item.subtitle) { %>
      <span class="listing-subtitle"><%= item.subtitle %></span>
      <% } %>
    </span>
    <% if (item['reading-time']) { %>
    <span class="listing-reading-time"><%= item['reading-time'] %></span>
    <% } %>
  </a>
<% } %>
</div>
```
