# SiteVouch

SiteVouch is a Chrome extension for experimenting with [ideas](https://docs.google.com/document/d/1wTFafdHa-o3OYCKmYzEJGROrpSoxXN6DNXPltzdiUzg/edit?tab=t.0#heading=h.40o7mijeapa7) around built-in browser support for website reputation signalling. As just a weekend hobby project and rapid prototype, this was hacked together quickly using Gemini and Google Antigravity without any tests or other engineering rigour.

## Vision

Users sometimes consult reviews and ratings of websites to help determine how much they should be trusted, but this is laborious. Browsers can help by automating this task and proactively providing a summary of what the user would discover if they had put the effort into their own preferred approach to reputation checking.

## Goals
- Automatically indicate whether a website is reputable, disreputable or of mixed reputation while browsing. Zero clicks or configuration required (beyond providing an API key).
- [Empower](https://www.youtube.com/watch?v=nTaAKbK6nXg) users to select their own trusted sources of website reputation signals. Don't presume any "root of trust".
- Enable the user to very easily get a summary of reputation for a site from each source, and click through to read full details.
- Be useful for most websites without requiring explicit integration from reputation sources.
- Clearly surface disagreements across different sources to help users refine which sources they find most useful.

## Design
- Allow the user to enter a list of websites as trusted providers of reputation (Eg. [BBB.org](https://bbb.org), [TrustPilot.com](https://trustpilot.com)).
- Whenever the user visits a new website, use Google Gemini with Google Search grounding to generate a reputation summary for the site from each of the trusted providers.
- Show a thumbs up or thumbs down icon for any site whose reputation is consistently positive or native. Use a neutral icon when the reputation is mixed.
- When the user clicks the extension, show a popup with a brief summary of any reputation signals for the current website from trusted sources. Clicking a source opens the originating review page.

<img width="1764" height="1474" alt="image" src="https://github.com/user-attachments/assets/78161f6b-82c3-4f93-bdac-92880b269e2c" />
<img width="2508" height="1292" alt="image" src="https://github.com/user-attachments/assets/b3d28735-867f-418a-a574-c37e38af49bf" />
<img width="2306" height="1344" alt="image" src="https://github.com/user-attachments/assets/de555db8-5b10-4193-965d-06d54c7eb3bb" />
<img width="2392" height="1462" alt="image" src="https://github.com/user-attachments/assets/f7a1daa0-3e66-4a18-b02f-0976b1b0e820" />

## Limitations
- Requires the user to provide their own [Gemini API key](https://aistudio.google.com/api-keys), which (after a free trial period) will incur a small cost.
- LLM-based approach with search grounding is (not entirely reliable)[https://github.com/RByers/SiteVouch/issues/1]. In particular there can be some halucination, especially in the review URLs.
- Takes up to a minute to gather signals for a new site in the background.
- Operates only at the granularity of a site, not useful for getting reputation on specific pages or channels in aggregation sites like YouTube.

## Installation
 - Clone this repo: `git clone https://github.com/RByers/SiteVouch.git`
 - Open `chrome://extensions/`, enable Developer Mode, and use "Load Unpacked Extension"
 - Pin the SiteVouch icon in your extensions list. 
 Right click on the SiteVouch icon and select "Options"
 - Get a [Gemini API key](https://aistudio.google.com/api-keys) and paste it here.
 - Start browsing and watch the extension icon. Manually consult some site reviews, and the extension should learn to search those sources automatically.

## FAQ

**Q) Isn't relying on the user's choice of sources just going to reinforce their biases (like a "filter buuble")?

Perhaps, but for something hoping to be built into a major browser there is no other choice. Also research suggests that empowering people to make their preferred appraoch to fact-checking easier is more likely to be effective than trying to convince people they should trust any particular source not of their own choosing. 

**Q) Shouldn't we also look at the URL or content on the page to really establish reputation? Eg. for a site like YouTube, it's often the channel whose reputation matters, not the site.**

A) That would certainly be valuable, but doing per-page analysis adds a host of additional cost and complexity. This extension attempts to explore the most tractable subset of the reputation problem. That said, I do plan to experiment with a different version of this extension which explores this space.

**Q) How can we speed it up?**

A) In a real built-in browser implementation we'd likely cache host/source results on a server. This would make it close to instant most of the time.

