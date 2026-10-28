-- Applied by examples/chinook/prepare.py --view-copy to a separate working
-- copy, never to the upstream artifact. The disclosure below sits inside the
-- statement so SQLite keeps it in the stored view definition.
CREATE VIEW InvoiceLineCustomer AS
-- Authored for the Knowledge Inspector Chinook demonstration; NOT part of
-- upstream Chinook v1.4.5. Each InvoiceLine row, inner-joined on its declared
-- foreign key to the Invoice row it belongs to, putting that invoice's
-- recorded CustomerId beside the line's own references. No filtering, no
-- aggregation, no computed values: every column is copied from a stored row.
SELECT
  line.InvoiceLineId AS InvoiceLineId,
  line.InvoiceId     AS InvoiceId,
  invoice.CustomerId AS CustomerId,
  line.TrackId       AS TrackId,
  line.UnitPrice     AS UnitPrice,
  line.Quantity      AS Quantity
FROM InvoiceLine AS line
JOIN Invoice AS invoice ON invoice.InvoiceId = line.InvoiceId;
