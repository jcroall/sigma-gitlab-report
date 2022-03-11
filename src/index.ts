#!/usr/bin/env node

import {
  gitlabCreateDiscussion,
  gitlabGetDiffMap,
  gitlabGetDiscussions,
  gitlabGetProject,
  SigmaIssuesView,
  gitlabUpdateNote
} from "@jcroall/synopsys-sig-node/lib"
import {sigmaCreateMessageFromIssue, sigmaIsInDiff, sigmaUuidCommentOf} from "@jcroall/synopsys-sig-node/lib"
import {logger} from "@jcroall/synopsys-sig-node/lib";
import * as fs from "fs";

const chalk = require('chalk')
const figlet = require('figlet')
const program = require('commander')

export async function main(): Promise<number> {
  console.log(
      chalk.blue(
          figlet.textSync('sigma-gitlab', { horizontalLayout: 'full' })
      )
  )
  program
      .description("Integrate Synopsys Sigma Static Analysis into GitLab")
      .option('-j, --json <Sigma Results JSON>', 'Location of the Sigma Results JSON')
      .option('-d, --debug', 'Enable debug mode (extra verbosity)')
      .parse(process.argv)

  const options = program.opts()

  logger.info(`Starting Sigma GitLab Integration`)

  const sigma_results_file: string = undefined === options.json
      ? 'sigma-results.json'
      : options.json || 'sigma-results.json'

  logger.info(`Json file: ${sigma_results_file}`)

  if (!process.argv.slice(2).length) {
    program.outputHelp()
  }

  if (options.debug) {
    logger.level = 'debug'
    logger.debug(`Enabled debug mode`)
  }

  const GITLAB_TOKEN = process.env['GITLAB_TOKEN']
  const CI_SERVER_URL = process.env['CI_SERVER_URL']
  const CI_MERGE_REQUEST_IID = process.env['CI_MERGE_REQUEST_IID'] // MR Only
  const CI_MERGE_REQUEST_DIFF_BASE_SHA = process.env['CI_MERGE_REQUEST_DIFF_BASE_SHA'] // MR Only
  const CI_PROJECT_NAMESPACE = process.env['CI_PROJECT_NAMESPACE']
  const CI_PROJECT_NAME = process.env['CI_PROJECT_NAME']
  const CI_PROJECT_ID = process.env['CI_PROJECT_ID']
  const CI_COMMIT_BRANCH = process.env['CI_COMMIT_BRANCH'] // Push only

  if (!GITLAB_TOKEN || !CI_SERVER_URL || !CI_PROJECT_NAMESPACE || !CI_PROJECT_NAME || !CI_PROJECT_ID) {
    logger.error(`Must specify GITLAB_TOKEN, CI_SERVER_URL, CI_PROJECT_NAMESPACE, CI_PROJECT_ID and CI_PROJECT_NAME.`)
    return 1
  }

  let is_merge_request = !!CI_MERGE_REQUEST_IID

  if (!is_merge_request) {
    if (!CI_COMMIT_BRANCH) {
      logger.error(`Must specify CI_COMMIT_BRANCH.`)
      return 1
    }
  } else {
    if (!CI_MERGE_REQUEST_DIFF_BASE_SHA) {
      logger.error(`Must specify CI_MERGE_REQUEST_DIFF_BASE_SHA when running from merge request.`)
      return 1
    }
  }

  logger.info(`Connecting to GitLab: ${CI_SERVER_URL}`)

  let project = await gitlabGetProject(CI_SERVER_URL, GITLAB_TOKEN, CI_PROJECT_ID)

  logger.debug(`Project=${project.name}`)

  let diff_map = undefined
  let discussions = undefined
  let merge_request_iid = 0

  if (is_merge_request && CI_MERGE_REQUEST_IID) {
    merge_request_iid = parseInt(CI_MERGE_REQUEST_IID, 10)
    discussions = await gitlabGetDiscussions(CI_SERVER_URL, GITLAB_TOKEN, CI_PROJECT_ID, merge_request_iid)

    diff_map = await gitlabGetDiffMap(CI_SERVER_URL, GITLAB_TOKEN, CI_PROJECT_ID, merge_request_iid)
  }

  const jsonContent = fs.readFileSync(sigma_results_file)
  const sigmaIssues = JSON.parse(jsonContent.toString()) as SigmaIssuesView

  for (const issue of sigmaIssues.issues.issues) {
    // Azure paths begin with /
    // issue.filepath = issue.filepath

    logger.info(`Found Sigma Issue ${issue.uuid} at ${issue.filepath}:${issue.location.start.line}`)

    if (is_merge_request && diff_map) {
      if (!sigmaIsInDiff(issue, diff_map)) {
        logger.debug(`Skipping issue ${issue.uuid}, not in diff map`)
        continue
      }

      let issue_comment_body = sigmaCreateMessageFromIssue(issue)

      logger.debug(`New comment body will be: "${issue_comment_body}"`)

      try {
        const uuidComment = sigmaUuidCommentOf(issue)

        let updated_existing_comment = false

        if (discussions) {
          for (const discussion of discussions) {
            if (discussion.notes && discussion.notes[0].body.includes(uuidComment)) {
              logger.debug(`Found existing thread #${discussion.id}`)
              let existing_discussion_id = parseInt(discussion.id, 10)
              let existing_note_id = discussion.notes[0].id

              logger.info(`Updating discussion ${existing_discussion_id} note #${existing_note_id} for ${issue.uuid}`)

              let status = gitlabUpdateNote(CI_SERVER_URL, GITLAB_TOKEN, CI_PROJECT_ID, merge_request_iid, existing_discussion_id,
                  existing_note_id, issue_comment_body)

              updated_existing_comment = true
              break
            }
          }
        }

        if (!updated_existing_comment) {
          logger.info(`Creating new comment for ${issue.uuid}`)
          let status = gitlabCreateDiscussion(CI_SERVER_URL, GITLAB_TOKEN, CI_PROJECT_ID, merge_request_iid, issue.location.start.line,
              issue.filepath, issue_comment_body, CI_MERGE_REQUEST_DIFF_BASE_SHA ? CI_MERGE_REQUEST_DIFF_BASE_SHA : '')

          if (!status) {
            logger.error(`Unable to comment on Sigma Issue ${issue.uuid}`)
          }
        }
      } catch (e) {
        logger.error(`Unable to comment on Sigma Issue ${issue.uuid}: ${e}`)
      }

    }
  }

  return 0
}

main()