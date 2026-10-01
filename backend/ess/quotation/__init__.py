"""Official quotation generator: templates, references, papers, signatures, catalog, HTML/PDF.

    from ess.quotation.templates import TEMPLATES, choose_template, default_quotation
    from ess.quotation.numbering import next_reference, parse_reference
    from ess.quotation.papers import list_papers, get_paper
    from ess.quotation.assets import LetterheadAssets            # .load(private_dir, company, initials, paper_id)
    from ess.quotation.signature_import import detect_signature, extract_signature
    from ess.quotation.catalog import load_catalog, search_catalog, catalog_item
    from ess.quotation.photos import normalize_photo
    from ess.quotation.render import render_quotation_html, render_quotation_pdf
"""
from .assets import LetterheadAssets
from .catalog import Catalog, catalog_item, load_catalog, price_hint, search_catalog
from .numbering import next_reference, parse_reference
from .papers import Paper, default_paper_id, get_paper, list_papers
from .photos import normalize_photo
from .render import render_quotation_html, render_quotation_pdf
from .signature_import import SignatureNotFound, detect_signature, extract_signature
from .templates import TEMPLATES, choose_template, default_quotation

__all__ = [
    "TEMPLATES",
    "Catalog",
    "LetterheadAssets",
    "Paper",
    "SignatureNotFound",
    "catalog_item",
    "choose_template",
    "default_paper_id",
    "default_quotation",
    "detect_signature",
    "extract_signature",
    "get_paper",
    "list_papers",
    "load_catalog",
    "next_reference",
    "normalize_photo",
    "parse_reference",
    "price_hint",
    "render_quotation_html",
    "render_quotation_pdf",
    "search_catalog",
]
