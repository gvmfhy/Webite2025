```{=html}
<div class="list archive-list">
<% for (const item of items) { %>
  <article class="quarto-post archive-entry" <%= metadataAttrs(item) %>>
    <div class="archive-entry__meta">
      <% if (item.date) { %>
      <time class="listing-date"><%= item.date %></time>
      <% } %>
      <% if (item['reading-time']) { %>
      <span class="listing-reading-time"><%= item['reading-time'] %></span>
      <% } %>
    </div>
    <div class="archive-entry__body">
      <h3 class="listing-title no-anchor"><a href="<%- item.path %>" class="no-external"><%= item.title %></a></h3>
      <% if (item.subtitle) { %>
      <p class="listing-subtitle"><%= item.subtitle %></p>
      <% } %>
      <% if (item.categories) { %>
      <div class="listing-categories" aria-label="Categories">
        <% for (const category of item.categories) { %>
        <button type="button" class="listing-category" onclick="window.quartoListingCategory('<%= utils.b64encode(category) %>'); return false;"><%= category %></button>
        <% } %>
      </div>
      <% } %>
    </div>
  </article>
<% } %>
</div>
```
