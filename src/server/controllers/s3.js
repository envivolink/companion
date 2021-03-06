const router = require('express').Router
const logger = require('../logger')

module.exports = function s3(config) {
    if (typeof config.acl !== 'string') {
        throw new TypeError('s3: The `acl` option must be a string')
    }
    if (typeof config.getData !== 'function') {
        throw new TypeError('s3: The `getData` option must be a function')
    }

    logger.info(`i am here ${config.getData}`, 'companion.client.s3')

    /**
     * Get upload paramaters for a simple direct upload.
     *
     * Expected query parameters:
     *  - filename - The name of the file, given to the `config.getKey`
     *    option to determine the object key name in the S3 bucket.
     *  - type - The MIME type of the file.
     *  - metadata - Key/value pairs configuring S3 metadata. Both must be ASCII-safe.
     *    Query parameters are formatted like `metadata[name]=value`.
     *
     * Response JSON:
     *  - method - The HTTP method to use to upload.
     *  - url - The URL to upload to.
     *  - fields - Form fields to send along.
     */
    function getUploadParameters(req, res, next) {
        // @ts-ignore The `companion` property is added by middleware before reaching here.
        const client = req.companion.s3Client
        const metadata = req.query.metadata || {}
        const dataKey = config.getData(req, req.query.filename, metadata)
        if (typeof dataKey.key !== 'string') {
            return res.status(500).json({ error: 's3: filename returned from `getData` must be a string' })
        }

        const fields = {
            acl: config.acl,
            key: dataKey.key,
            success_action_status: '201',
            'content-type': req.query.type
        }

        Object.keys(metadata).forEach((key) => {
            fields[`x-amz-meta-${key}`] = metadata[key]
        })

        logger.info(`bucket ${dataKey.bucket}`, 'companion.client.s3')

        client.createPresignedPost({
            Bucket: dataKey.bucket,
            Expires: config.expires,
            Fields: fields,
            Conditions: config.conditions
        }, (err, data) => {
            if (err) {
                next(err)
                return
            }
            res.json({
                method: 'post',
                url: data.url,
                fields: data.fields
            })
        })
    }

    /**
     * Create an S3 multipart upload. With this, files can be uploaded in chunks of 5MB+ each.
     *
     * Expected JSON body:
     *  - filename - The name of the file, given to the `config.getKey`
     *    option to determine the object key name in the S3 bucket.
     *  - type - The MIME type of the file.
     *  - metadata - An object with the key/value pairs to set as metadata.
     *    Keys and values must be ASCII-safe for S3.
     *
     * Response JSON:
     *  - key - The object key in the S3 bucket.
     *  - uploadId - The ID of this multipart upload, to be used in later requests.
     */
    function createMultipartUpload(req, res, next) {
        // @ts-ignore The `companion` property is added by middleware before reaching here.
        const client = req.companion.s3Client

        const { type, metadata } = req.body

        const dataKey = config.getData(req, req.query.filename, metadata)

        if (typeof dataKey.key !== 'string') {
            return res.status(500).json({ error: 's3: filename returned from `getKey` must be a string' })
        }
        if (typeof type !== 'string') {
            return res.status(400).json({ error: 's3: content type must be a string' })
        }

        logger.info(`bucket ${dataKey.bucket}`, 'companion.client.s3')
        logger.info(`key ${dataKey.key}`, 'companion.client.s3')

        client.createMultipartUpload({
            Bucket: dataKey.bucket,
            Key: dataKey.key,
            ACL: config.acl,
            ContentType: type,
            Metadata: metadata,
            Expires: config.expires
        }, (err, data) => {
            if (err) {
                next(err)
                return
            }
            res.json({
                key: data.Key,
                uploadId: data.UploadId
            })
        })
    }

    /**
     * List parts that have been fully uploaded so far.
     *
     * Expected URL parameters:
     *  - uploadId - The uploadId returned from `createMultipartUpload`.
     * Expected query parameters:
     *  - key - The object key in the S3 bucket.
     * Response JSON:
     *  - An array of objects representing parts:
     *     - PartNumber - the index of this part.
     *     - ETag - a hash of this part's contents, used to refer to it.
     *     - Size - size of this part.
     */
    function getUploadedParts(req, res, next) {
        // @ts-ignore The `companion` property is added by middleware before reaching here.
        const client = req.companion.s3Client
        const { uploadId } = req.params
        const { key } = req.query

        const dataKey = config.getData(req, req.query.filename, req.body.metadata)

        if (typeof dataKey.key !== 'string') {
            return res.status(400).json({ error: 's3: the object key must be passed as a query parameter. For example: "?key=abc.jpg"' })
        }

        let parts = []
        listPartsPage(0)

        function listPartsPage(startAt) {
            client.listParts({
                Bucket: dataKey.bucket,
                Key: dataKey.key,
                UploadId: uploadId,
                PartNumberMarker: startAt
            }, (err, data) => {
                if (err) {
                    next(err)
                    return
                }

                parts = parts.concat(data.Parts)

                if (data.IsTruncated) {
                    // Get the next page.
                    listPartsPage(data.NextPartNumberMarker)
                } else {
                    done()
                }
            })
        }

        function done() {
            res.json(parts)
        }
    }

    /**
     * Get parameters for uploading one part.
     *
     * Expected URL parameters:
     *  - uploadId - The uploadId returned from `createMultipartUpload`.
     *  - partNumber - This part's index in the file (1-10000).
     * Expected query parameters:
     *  - key - The object key in the S3 bucket.
     * Response JSON:
     *  - url - The URL to upload to, including signed query parameters.
     */
    function signPartUpload(req, res, next) {
        // @ts-ignore The `companion` property is added by middleware before reaching here.
        const client = req.companion.s3Client
        const { uploadId, partNumber } = req.params
        const { key } = req.query

        const dataKey = config.getData(req, req.query.filename, req.body.metadata)

        if (typeof dataKey.key !== 'string') {
            return res.status(400).json({ error: 's3: the object key must be passed as a query parameter. For example: "?key=abc.jpg"' })
        }
        if (!parseInt(partNumber, 10)) {
            return res.status(400).json({ error: 's3: the part number must be a number between 1 and 10000.' })
        }

        console.log('uploading part', partNumber)

        client.getSignedUrl('uploadPart', {
            Bucket: dataKey.bucket,
            Key: dataKey.key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: '',
            Expires: config.expires
        }, (err, url) => {
            if (err) {
                next(err)
                return
            }
            res.json({ url })
        })
    }

    /**
     * Abort a multipart upload, deleting already uploaded parts.
     *
     * Expected URL parameters:
     *  - uploadId - The uploadId returned from `createMultipartUpload`.
     * Expected query parameters:
     *  - key - The object key in the S3 bucket.
     * Response JSON:
     *   Empty.
     */
    function abortMultipartUpload(req, res, next) {
        // @ts-ignore The `companion` property is added by middleware before reaching here.
        const client = req.companion.s3Client
        const { uploadId } = req.params
        const { key } = req.query

        const dataKey = config.getData(req, req.query.filename, req.body.metadata)

        if (typeof dataKey.key !== 'string') {
            return res.status(400).json({ error: 's3: the object key must be passed as a query parameter. For example: "?key=abc.jpg"' })
        }

        client.abortMultipartUpload({
            Bucket: dataKey.bucket,
            Key: dataKey.key,
            UploadId: uploadId
        }, (err, data) => {
            if (err) {
                next(err)
                return
            }
            res.json({})
        })
    }

    /**
     * Complete a multipart upload, combining all the parts into a single object in the S3 bucket.
     *
     * Expected URL parameters:
     *  - uploadId - The uploadId returned from `createMultipartUpload`.
     * Expected query parameters:
     *  - key - The object key in the S3 bucket.
     * Expected JSON body:
     *  - parts - An array of parts, see the `getUploadedParts` response JSON.
     * Response JSON:
     *  - location - The full URL to the object in the S3 bucket.
     */
    function completeMultipartUpload(req, res, next) {
        // @ts-ignore The `companion` property is added by middleware before reaching here.
        const client = req.companion.s3Client
        const { uploadId } = req.params
        const { key } = req.query
        const { parts } = req.body

        const dataKey = config.getData(req, req.query.filename, req.body.metadata)

        if (typeof dataKey.key !== 'string') {
            return res.status(400).json({ error: 's3: the object key must be passed as a query parameter. For example: "?key=abc.jpg"' })
        }
        if (!Array.isArray(parts) || !parts.every(isValidPart)) {
            return res.status(400).json({ error: 's3: `parts` must be an array of {ETag, PartNumber} objects.' })
        }

        client.completeMultipartUpload({
            Bucket: dataKey.bucket,
            Key: dataKey.key,
            UploadId: uploadId,
            MultipartUpload: {
                Parts: parts
            }
        }, (err, data) => {
            if (err) {
                next(err)
                return
            }
            res.json({
                location: data.Location
            })
        })
    }

    return router()
        .get('/params', getUploadParameters)
        .post('/multipart', createMultipartUpload)
        .get('/multipart/:uploadId', getUploadedParts)
        .get('/multipart/:uploadId/:partNumber', signPartUpload)
        .post('/multipart/:uploadId/complete', completeMultipartUpload)
        .delete('/multipart/:uploadId', abortMultipartUpload)
}

function isValidPart(part) {
    return part && typeof part === 'object' && typeof part.PartNumber === 'number' && typeof part.ETag === 'string'
}