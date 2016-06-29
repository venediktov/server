import Promise from 'bluebird';
import GitHubApi from 'github';

// configure github api client
let github = new GitHubApi({});
if (process.env.GITHUB_TOKEN) {
  github.authenticate({
    type: "oauth",
    token: process.env.GITHUB_TOKEN,
  });
} else {
  console.warn("Warning: No github token specified.");
}

let gh = {
  reposGet: Promise.promisify(github.repos.get),
  reposGetBranch: Promise.promisify(github.repos.getBranch),
  reposGetForks: Promise.promisify(github.repos.getForks),
  pullRequestsCreate: Promise.promisify(github.pullRequests.create),
  pullRequestsGetAll: Promise.promisify(github.pullRequests.getAll),

  reposCreateHook: Promise.promisify(github.repos.createHook),
};

// has the given fork diverged from its parent?
export function hasDivergedFromUpstream(platform, user, repo) {
  switch (platform) {
    case "github":
      let repoContents;
      return gh.reposGet({user, repo}).then(repoData => {
        repoContents = repoData;
        if (repoData.parent) {
          return Promise.all([
            // base branch
            gh.reposGetBranch({
              user,
              repo,
              branch: repoData.default_branch,
            }),
            // upstream branch
            gh.reposGetBranch({
              user: repoData.parent.owner.login,
              repo: repoData.parent.name,
              branch: repoData.parent.default_branch,
            }),
          ]);
        } else {
          throw new Error(`The repository ${user}/${repo} isn't a fork.`);
        }
      }).then(([base, upstream]) => {
        return {
          repo: repoContents,
          diverged: base.commit.sha !== upstream.commit.sha,
          baseSha: base.commit.sha,
          upstreamSha: upstream.commit.sha,
        };
      });
    default:
      return Promise.reject(`No such platform ${platform}`);
  }
}

export function generateUpdateBody(fullRemote) {
  return `Hello!
  The remote \`${fullRemote}\` has some new changes that aren't in this fork.

  So, here they are, ready to be merged. 
  
  If this pull request can be merged without conflict, you can publish your software with these new changes. If not, this branch is a great place to fix any issues.

  Have fun!
  --------
  Created by [Backstroke](http://backstroke.us)
  `
}

// given a platform and a repository, open the pr to update it to its upstream.
export function postUpdate(platform, repo, upstreamSha) {
  switch (platform) {
    case "github":
      if (repo) {
        if (repo.parent) {
          return gh.pullRequestsGetAll({
            user: repo.owner.login,
            repo: repo.name,
            state: "open",
            head: `${repo.parent.owner.login}:${repo.parent.default_branch}`,
          }).then(existingPulls => {
            // are we trying to reintroduce a pull request that has already been
            // cancelled by the user earlier?
            let duplicateRequests = existingPulls.find(pull => pull.head.sha === upstreamSha);
            if (!duplicateRequests) {
              // create a pull request to merge in remote changes
              return gh.pullRequestsCreate({
                user: repo.owner.login, repo: repo.name,
                title: `Update from upstream repo ${repo.parent.full_name}`,
                head: `${repo.parent.owner.login}:${repo.parent.default_branch}`,
                base: repo.default_branch,
                body: generateUpdateBody(repo.parent.full_name),
              });
            } else {
              throw new Error(`The PR already has been made.`);
            }
          });
        } else {
          throw new Error(`The repository ${repo.full_name} isn't a fork.`);
        }
      } else {
        throw new Error(`No repository found for ${repo.full_name}`);
      }
    default:
      return Promise.reject(`No such platform ${platform}`);
  }
}

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------

export function webhook(req, res) {
  if (req.body && req.body.repository && req.body.repository.fork) {
    // Try to merge upstream changes into the passed repo
    return isForkMergeUpstream(req, res);
  } else {
    // Find all forks of the current repo and merge the passed repo's changes
    // into each
    return isParentFindForks(req, res);
  }
}

export function isForkMergeUpstream(req, res) {
  hasDivergedFromUpstream(
    "github",
    req.body.repository.owner.login,
    req.body.repository.name
  ).then(({repo, diverged, upstreamSha}) => {
    if (diverged) {
      // make a pull request
      return postUpdate("github", repo, upstreamSha);
    } else {
      res.send("Thanks anyway, but we don't care about that event.");
    }
  }).then(ok => {
    res.send("Cool, thanks github.");
  }).catch(err => {
    res.send(`Uhh, error: ${err}`);
  });
}

export function isParentFindForks(req, res) {
  gh.reposGetForks({
    user: req.body.repository.owner.login,
    repo: req.body.repository.name,
  }).then(forks => {
    let pullreqs = forks.map(fork => {
      return hasDivergedFromUpstream(
        "github",
        fork.owner.login, // user
        fork.name         // repo
      ).then(({repo, diverged, upstreamSha}) => {
        if (diverged) {
          // make a pull request
          return postUpdate("github", repo, upstreamSha);
        } else {
          return null;
        }
      });
    });

    Promise.all(pullreqs).then(reqs => {
      let madePRs = reqs.filter(i => i); // all truthy pull requests
      res.send(`Opened ${madePRs.length} pull requests on forks of this repository.`);
    });
  }).catch(err => {
    res.send(`Uhh, error: ${err}`);
  });
}
